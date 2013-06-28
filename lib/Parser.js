var EventEmitter = require('events').EventEmitter,
    ReadableStream = require('stream').Readable || require('readable-stream'),
    inherits = require('util').inherits,
    inspect = require('util').inspect,
    utf7 = require('utf7').imap;

var CH_LF = 10,
    LITPLACEHOLDER = String.fromCharCode(0),
    EMPTY_READCB = function(n) {},
    RE_INTEGER = /^\d+$/,
    RE_PRECEDING = /^(?:\*|A\d+|\+) /,
    RE_BODYLITERAL = /BODY\[(.*)\] \{(\d+)\}$/i,
    RE_SEQNO = /^\* (\d+)/,
    RE_LISTCONTENT = /^\((.*)\)$/,
    RE_LITERAL = /\{(\d+)\}$/,
    RE_UNTAGGED = /^\* (?:(OK|NO|BAD|BYE|FLAGS|LIST|LSUB|SEARCH|STATUS|CAPABILITY|NAMESPACE|PREAUTH|SORT)|(\d+) (EXPUNGE|FETCH|RECENT|EXISTS))(?: (?:\[([^\]]+)\] )?(.+))?$/i,
    RE_TAGGED = /^A(\d+) (OK|NO|BAD) (?:\[([^\]]+)\] )?(.+)$/i,
    RE_CONTINUE = /^\+ (?:\[([^\]]+)\] )?(.+)$/i,
    RE_CRLF = /\r\n/g,
    RE_HDR = /^([^:]+):[ \t]?(.+)?$/;

function Parser(stream, debug) {
  if (!(this instanceof Parser))
    return new Parser(stream, debug);

  EventEmitter.call(this);

  this._stream = stream;
  this._body = undefined;
  this._literallen = 0;
  this._literals = [];
  this._buffer = '';
  this.debug = debug;

  var self = this;
  function cb() {
    if (self._literallen > 0)
      self._tryread(self._literallen);
    else
      self._tryread();
  }
  this._stream.on('readable', cb);
  process.nextTick(cb);
}
inherits(Parser, EventEmitter);

Parser.prototype._tryread = function(n) {
  var r = this._stream.read(n);
  r && this._parse(r);
};

Parser.prototype._parse = function(data) {
  var i = 0, datalen = data.length, idxlf;

  if (this._literallen > 0) {
    if (this._body) {
      var body = this._body;
      if (datalen > this._literallen) {
        var litlen = this._literallen;

        i = this._literallen;
        this._literallen = 0;
        this._body = undefined;

        body.push(data.slice(0, litlen));
      } else {
        this._literallen -= datalen;
        var r = body.push(data);
        if (!r && this._literallen > 0)
          return;
        i = datalen;
      }
      if (this._literallen === 0) {
        body._read = EMPTY_READCB;
        body.push(null);
      }
    } else {
      if (datalen > this._literallen)
        this._literals.push(data.slice(0, this._literallen));
      else
        this._literals.push(data);
      i = this._literallen;
      this._literallen = 0;
    }
  }

  while (i < datalen) {
    idxlf = indexOfCh(data, datalen, i, CH_LF);
    if (idxlf === -1) {
      this._buffer += data.toString('utf8');
      break;
    } else {
      this._buffer += data.toString('utf8', i, idxlf);
      this._buffer = this._buffer.trim();
      i = idxlf + 1;

      this.debug && this.debug('<= ' + inspect(this._buffer));

      var clearBuffer = false;

      if (RE_PRECEDING.test(this._buffer)) {
        var firstChar = this._buffer[0];
        if (firstChar === '*')
          clearBuffer = this._resUntagged();
        else if (firstChar === 'A')
          clearBuffer = this._resTagged();
        else if (firstChar === '+')
          clearBuffer = this._resContinue();

        if (this._literallen > 0 && i < datalen) {
          // literal data included in this chunk -- put it back onto stream
          this._stream.unshift(data.slice(i));
          i = datalen;
          if (!this._body && this._literallen > 0) {
            // check if unshifted contents satisfies non-body literal length
            this._tryread(this._literallen);
          }
        }
      } else {
        this.emit('other', this._buffer);
        clearBuffer = true;
      }

      if (clearBuffer)
        this._buffer = '';
    }
  }

  if (this._literallen === 0 || this._body)
    this._tryread();
};

Parser.prototype._resTagged = function() {
  var ret = false;
  if (m = RE_LITERAL.exec(this._buffer)) {
    // non-BODY literal -- buffer it
    this._buffer = this._buffer.replace(RE_LITERAL, LITPLACEHOLDER);
    this._literallen = parseInt(m[1], 10);
    this._tryread(this._literallen);
  } else {
    var m = RE_TAGGED.exec(this._buffer),
        tagnum = parseInt(m[1], 10),
        type = m[2].toLowerCase(),
        textCode = (m[3] ? parseTextCode(m[3], this._literals) : m[3]),
        text = m[4];

    this._literals = [];

    this.emit('tagged', {
      type: type,
      tagnum: tagnum,
      textCode: textCode,
      text: text
    });

    ret = true;
  }

  return ret;
};

Parser.prototype._resUntagged = function() {
  var ret = false, self = this, m;
  if (m = RE_BODYLITERAL.exec(this._buffer)) {
    // BODY literal -- stream it
    var which = m[1], size = parseInt(m[2], 10);
    this._literallen = size;
    this._body = new ReadableStream();
    this._body._read = function bodyread(n) {
      self._tryread();
    };
    m = RE_SEQNO.exec(this._buffer);
    this._buffer = this._buffer.replace(RE_BODYLITERAL, '');
    this.emit('body', this._body, {
      seqno: parseInt(m[1], 10),
      which: which,
      size: size
    });
  } else if (m = RE_LITERAL.exec(this._buffer)) {
    // non-BODY literal -- buffer it
    this._buffer = this._buffer.replace(RE_LITERAL, LITPLACEHOLDER);
    this._literallen = parseInt(m[1], 10);
    this._tryread(this._literallen);
  } else if (m = RE_UNTAGGED.exec(this._buffer)) {
    // normal single line response

    // m[1] or m[3] = response type
    // if m[3] is set, m[2] = sequence number (for FETCH) or count
    // m[4] = response text code (optional)
    // m[5] = response text (optional)

    var type, num, textCode, val;
    if (m[2] !== undefined)
      num = parseInt(m[2], 10);
    if (m[4] !== undefined)
      textCode = parseTextCode(m[4], this._literals);

    type = (m[1] || m[3]).toLowerCase();

    if (type === 'flags'
        || type === 'search'
        || type === 'capability'
        || type === 'sort') {
      if (m[5]) {
        if (m[5][0] === '(')
          val = RE_LISTCONTENT.exec(m[5])[1].split(' ');
        else
          val = m[5].split(' ');

        if (type === 'search' || type === 'sort')
          val = val.map(function(v) { return parseInt(v, 10); });
      } else
        val = [];
    } else if (type === 'list' || type === 'lsub')
      val = parseBoxList(m[5], this._literals);
    else if (type === 'status')
      val = parseStatus(m[5], this._literals);
    else if (type === 'fetch')
      val = parseFetch(m[5], this._literals);
    else if (type === 'namespace')
      val = parseNamespaces(m[5], this._literals);
    else
      val = m[5];

    this._literals = [];

    this.emit('untagged', {
      type: type,
      num: num,
      textCode: textCode,
      text: val
    });
    ret = true;
  } else
    ret = true;
  return ret;
};

Parser.prototype._resContinue = function() {
  var m = RE_CONTINUE.exec(this._buffer), textCode, text = m[2];

  if (m[1] !== undefined)
    textCode = parseTextCode(m[1], this._literals);

  this.emit('continue', {
    textCode: textCode,
    text: text
  });

  return true;
};

function indexOfCh(buffer, len, i, ch) {
  var r = -1;
  for (; i < len; ++i) {
    if (buffer[i] === ch) {
      r = i;
      break;
    }
  }
  return r;
}

function parseTextCode(text, literals) {
  var r = parseExpr(text, literals);
  if (r.length === 1)
    return r[0];
  else
    return { key: r[0], val: r[1] };
}

function parseBoxList(text, literals) {
  var r = parseExpr(text, literals);
  return {
    flags: r[0],
    delimiter: r[1],
    name: utf7.decode(''+r[2])
  };
}

function parseNamespaces(text, literals) {
  var r = parseExpr(text, literals), i, len, j, len2, ns, nsobj, namespaces, n;

  for (n = 0; n < 3; ++n) {
    if (r[n]) {
      namespaces = [];
      for (i = 0, len = r[n].length; i < len; ++i) {
        ns = r[n][i];
        nsobj = {
          prefix: ns[0],
          delimiter: ns[1],
          extensions: undefined
        };
        if (ns.length > 2)
          nsobj.extensions = {};
        for (j = 2, len2 = ns.length; j < len2; j += 2)
          nsobj.extensions[ns[j]] = ns[j + 1];
        namespaces.push(nsobj);
      }
      r[n] = namespaces;
    }
  }

  return {
    personal: r[0],
    other: r[1],
    shared: r[2]
  };
}

function parseStatus(text, literals) {
  var r = parseExpr(text, literals), attrs = {};
  // r[1] is [KEY1, VAL1, KEY2, VAL2, .... KEYn, VALn]
  for (var i = 0, len = r[1].length; i < len; i += 2)
    attrs[r[1][i].toLowerCase()] = r[1][i + 1];
  return {
    name: utf7.decode(''+r[0]),
    attrs: attrs
  };
}

function parseFetch(text, literals) {
  var list = parseExpr(text, literals)[0], attrs = {};
  // list is [KEY1, VAL1, KEY2, VAL2, .... KEYn, VALn]
  for (var i = 0, len = list.length, key, val; i < len; i += 2) {
    key = list[i].toLowerCase();
    val = list[i + 1];
    if (key === 'envelope')
      val = parseFetchEnvelope(val);
    else if (key === 'internaldate')
      val = new Date(val);
    else if (key === 'body')
      val = parseBodyStructure(val);
    attrs[key] = val;
  }
  return attrs;
}

function parseBodyStructure(cur, literals, prefix, partID) {
  var ret = [], i, len;
  if (prefix === undefined) {
    var result = (Array.isArray(cur) ? cur : parseExpr(cur, literals));
    if (result.length)
      ret = parseBodyStructure(result, literals, '', 1);
  } else {
    var part, partLen = cur.length, next;
    if (Array.isArray(cur[0])) { // multipart
      next = -1;
      while (Array.isArray(cur[++next])) {
        ret.push(parseBodyStructure(cur[next],
                                    literals,
                                    prefix + (prefix !== '' ? '.' : '')
                                           + (partID++).toString(), 1));
      }
      part = { type: cur[next++].toLowerCase() };
      if (partLen > next) {
        if (Array.isArray(cur[next])) {
          part.params = {};
          for (i = 0, len = cur[next].length; i < len; i += 2)
            part.params[cur[next][i].toLowerCase()] = cur[next][i + 1];
        } else
          part.params = cur[next];
        ++next;
      }
    } else { // single part
      next = 7;
      if (typeof cur[1] === 'string') {
        part = {
          // the path identifier for this part, useful for fetching specific
          // parts of a message
          partID: (prefix !== '' ? prefix : '1'),

          // required fields as per RFC 3501 -- null or otherwise
          type: cur[0].toLowerCase(), subtype: cur[1].toLowerCase(),
          params: null, id: cur[3], description: cur[4], encoding: cur[5],
          size: cur[6]
        };
      } else {
        // type information for malformed multipart body
        part = { type: cur[0].toLowerCase(), params: null };
        cur.splice(1, 0, null);
        ++partLen;
        next = 2;
      }
      if (Array.isArray(cur[2])) {
        part.params = {};
        for (i = 0, len = cur[2].length; i < len; i += 2)
          part.params[cur[2][i].toLowerCase()] = cur[2][i + 1];
        if (cur[1] === null)
          ++next;
      }
      if (part.type === 'message' && part.subtype === 'rfc822') {
        // envelope
        if (partLen > next && Array.isArray(cur[next]))
          part.envelope = parseFetchEnvelope(cur[next]);
        else
          part.envelope = null;
        ++next;

        // body
        if (partLen > next && Array.isArray(cur[next]))
          part.body = parseBodyStructure(cur[next], literals, prefix, 1);
        else
          part.body = null;
        ++next;
      }
      if ((part.type === 'text'
           || (part.type === 'message' && part.subtype === 'rfc822'))
          && partLen > next)
        part.lines = cur[next++];
      if (typeof cur[1] === 'string' && partLen > next)
        part.md5 = cur[next++];
    }
    // add any extra fields that may or may not be omitted entirely
    parseStructExtra(part, partLen, cur, next);
    ret.unshift(part);
  }
  return ret;
}

function parseStructExtra(part, partLen, cur, next) {
  if (partLen > next) {
    // disposition
    // null or a special k/v list with these kinds of values:
    // e.g.: ['Foo', null]
    //       ['Foo', ['Bar', 'Baz']]
    //       ['Foo', ['Bar', 'Baz', 'Bam', 'Pow']]
    var disposition = { type: null, params: null };
    if (Array.isArray(cur[next])) {
      disposition.type = cur[next][0];
      if (Array.isArray(cur[next][1])) {
        disposition.params = {};
        for (var i = 0, len = cur[next][1].length, key; i < len; i += 2) {
          key = cur[next][1][i].toLowerCase();
          disposition.params[key] = cur[next][1][i + 1];
        }
      }
    } else if (cur[next] !== null)
      disposition.type = cur[next];

    if (disposition.type === null)
      part.disposition = null;
    else
      part.disposition = disposition;

    ++next;
  }
  if (partLen > next) {
    // language can be a string or a list of one or more strings, so let's
    // make this more consistent ...
    if (cur[next] !== null)
      part.language = (Array.isArray(cur[next]) ? cur[next] : [cur[next]]);
    else
      part.language = null;
    ++next;
  }
  if (partLen > next)
    part.location = cur[next++];
  if (partLen > next) {
    // extension stuff introduced by later RFCs
    // this can really be any value: a string, number, or (un)nested list
    // let's not parse it for now ...
    part.extensions = cur[next];
  }
}

function parseFetchEnvelope(list) {
  return {
    date: new Date(list[0]),
    subject: list[1],
    from: parseEnvelopeAddresses(list[2]),
    sender: parseEnvelopeAddresses(list[3]),
    replyTo: parseEnvelopeAddresses(list[4]),
    to: parseEnvelopeAddresses(list[5]),
    cc: parseEnvelopeAddresses(list[6]),
    bcc: parseEnvelopeAddresses(list[7]),
    inReplyTo: list[8],
    messageId: list[9]
  };
}

function parseEnvelopeAddresses(list) {
  var addresses = null;
  if (Array.isArray(list)) {
    addresses = [];
    var inGroup = false, curGroup;
    for (var i = 0, len = list.length, addr; i < len; ++i) {
      addr = list[i];
      if (addr[2] === null) { // end of group addresses
        inGroup = false;
        if (curGroup) {
          addresses.push(curGroup);
          curGroup = undefined;
        }
      } else if (addr[3] === null) { // start of group addresses
        inGroup = true;
        curGroup = {
          group: addr[2],
          addresses: []
        };
      } else { // regular user address
        var info = {
          name: addr[0],
          mailbox: addr[2],
          host: addr[3]
        };
        if (inGroup)
          curGroup.addresses.push(info);
        else if (!inGroup)
          addresses.push(info);
      }
      list[i] = addr;
    }
    if (inGroup) {
      // no end of group found, assume implicit end
      addresses.push(curGroup);
    }
  }
  return addresses;
}

function parseExpr(o, literals, result, start, useBrackets) {
  start = start || 0;
  var inQuote = false, lastPos = start - 1, isTop = false, val;

  if (useBrackets === undefined)
    useBrackets = true;
  if (!result)
    result = [];
  if (typeof o === 'string') {
    o = { str: o };
    isTop = true;
  }
  for (var i = start, len = o.str.length; i < len; ++i) {
    if (!inQuote) {
      if (o.str[i] === '"')
        inQuote = true;
      else if (o.str[i] === ' ' || o.str[i] === ')'
               || (useBrackets && o.str[i] === ']')) {
        if (i - (lastPos + 1) > 0) {
          val = convStr(o.str.substring(lastPos + 1, i), literals);
          result.push(val);
        }
        if ((o.str[i] === ')' || (useBrackets && o.str[i] === ']')) && !isTop)
          return i;
        lastPos = i;
      } else if ((o.str[i] === '(' || (useBrackets && o.str[i] === '['))) {
        var innerResult = [];
        i = parseExpr(o, literals, innerResult, i + 1, useBrackets);
        lastPos = i;
        result.push(innerResult);
      }
    } else if (o.str[i] === '"' &&
               (o.str[i - 1] &&
                (o.str[i - 1] !== '\\'
                 || (o.str[i - 2] && o.str[i - 2] === '\\')
                )))
      inQuote = false;
    if (i + 1 === len && len - (lastPos + 1) > 0)
      result.push(convStr(o.str.substring(lastPos + 1), literals));
  }
  return (isTop ? result : start);
}

function convStr(str, literals) {
  if (str[0] === '"')
    return str.substring(1, str.length - 1);
  else if (str === 'NIL')
    return null;
  else if (RE_INTEGER.test(str)) {
    // some IMAP extensions utilize large (64-bit) integers, which JavaScript
    // can't handle natively, so we'll just keep it as a string if it's too big
    var val = parseInt(str, 10);
    return (val.toString() === str ? val : str);
  } else if (literals && literals.length && str === LITPLACEHOLDER) {
    var l = literals.shift();
    if (Buffer.isBuffer(l))
      l = l.toString('utf8');
    return l;
  }

  return str;
}

function parseHeader(str) {
  var lines = str.split(RE_CRLF),
      len = lines.length,
      modded = false,
      header = {},
      m, h;

  for (var i = 0; i < len; ++i) {
    if (lines[i].length === 0)
      continue;
    if (lines[i][0] === '\t' || lines[i][0] === ' ') {
      // folded header content
      // RFC2822 says to just remove the CRLF and not the whitespace following
      // it, so we follow the RFC and include the leading whitespace ...
      header[h][header[h].length - 1] += lines[i];
    } else {
      m = RE_HDR.exec(lines[i]);
      if (m) {
        h = m[1].toLowerCase();
        if (m[2]) {
          if (header[h] === undefined)
            header[h] = [m[2]];
          else
            header[h].push(m[2]);
        } else
          header[h] = [''];
      } else
        break;
    }
  }

  return header;
}

exports.Parser = Parser;
exports.parseExpr = parseExpr;
exports.parseEnvelopeAddresses = parseEnvelopeAddresses;
exports.parseBodyStructure = parseBodyStructure;
exports.parseHeader = parseHeader;