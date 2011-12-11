// This file was copied from https://github.com/substack/node-bufferlist
// and modified to be able to copy bytes from the bufferlist directly into
// a pre-existing fixed-size buffer without an additional memory allocation.
// BufferQueue.js
// Treat a linked list of buffers as a single variable-size buffer.
var Buffer = require('buffer').Buffer;
var EventEmitter = require('events').EventEmitter;

module.exports = BufferQueue;

function BufferQueue(opts) {
  if (! (this instanceof BufferQueue)) return new BufferQueue(opts);
  EventEmitter.call(this);
  var self = this;

  if (typeof(opts) == 'undefined') opts = {};

  // default encoding to use for take(). Leaving as 'undefined'
  // makes take() return a Buffer instead.
  self.encoding = opts.encoding;

  // constructor to use for Buffer-esque operations
  self.construct = opts.construct || Buffer;

  var head = 0;
  var tail = 0; // == # of objects
  var Queue = {};

  // length can get negative when advanced past the end
  // and this is the desired behavior
  var length = 0;
  self.__defineGetter__('length', function() {
    return length;
  });

  // keep an offset of the buffer at the first element
  var offset = 0;

  // Write to the bufferlist. Emits 'write'. Always returns true.
  self.write = function(buf) {
    Queue[(tail++).toString(16)] = buf;
    length += buf.length;
    self.emit('write', buf);
    return true;
  };

  self.end = function(buf) {
    if (buf instanceof Buffer) self.write(buf);
  };

  // For each buffer, perform some action.
  // If fn's result is a true value, cut out early.
  // Returns this (self).
  self.forEach = function(fn) {
    var position = head;

    if (!Queue[position.toString(16)]) return new self.construct(0);

    if (Queue[position.toString(16)].length - offset <= 0) return self;
    var firstBuf = new self.construct(Queue[position.toString(16)].length - offset);
    Queue[position.toString(16)].copy(firstBuf, 0, offset, Queue[position.toString(16)].length);

    var buf = firstBuf;

    while(buf) {
      var r = fn(buf);
      if (r) break;
      buf = Queue[(++position).toString(16)];
    }

    return self;
  };

  // Create a single Buffer out of all the chunks or some subset specified by
  // start and one-past the end (like slice) in bytes.
  self.join = function(start, end) {
    var position = head;

    if (!Queue[position.toString(16)]) return new self.construct(0);
    if (start == undefined) start = 0;
    if (end == undefined) end = self.length;

    var big = new self.construct(end - start);
    var ix = 0;
    self.forEach(function(buffer) {
      if (start < (ix + buffer.length) && ix < end) {
        // at least partially contained in the range
        buffer.copy(big, Math.max(0, ix - start), Math.max(0, start - ix), Math.min(buffer.length, end - ix));
      }
      ix += buffer.length;
      if (ix > end) return true; // stop processing past end
    });

    return big;
  };

  self.joinInto = function(targetBuffer, targetStart, sourceStart, sourceEnd) {
    var position = head;

    if (!Queue[position.toString(16)]) return new self.construct(0);
    if (sourceStart == undefined) sourceStart = 0;
    if (sourceEnd == undefined) sourceEnd = self.length;

    var big = targetBuffer;
    if (big.length - targetStart < sourceEnd - sourceStart) {
      throw new Error("Insufficient space available in target Buffer.");
    }
    var ix = 0;
    self.forEach(function(buffer) {
      if (sourceStart < (ix + buffer.length) && ix < sourceEnd) {
        // at least partially contained in the range
        buffer.copy(big, Math.max(targetStart, targetStart + ix - sourceStart), Math.max(0, sourceStart - ix), Math.min(buffer.length, sourceEnd - ix));
      }
      ix += buffer.length;
      if (ix > sourceEnd) return true; // stop processing past end
    });

    return big;
  };

  // Advance the buffer stream by n bytes.
  // If n the aggregate advance offset passes the end of the buffer list,
  // operations such as .take() will return empty strings until enough data is
  // pushed.
  // Returns this (self).
  self.advance = function(n) {
    offset += n;
    length -= n;
    while (Queue[head.toString(16)] && offset >= Queue[head.toString(16)].length) {
      offset -= Queue[(head++).toString(16)].length;
    }
    self.emit('advance', n);
    return self;
  };

  // Take n bytes from the start of the buffers.
  // Returns a string.
  // If there are less than n bytes in all the buffers or n is undefined,
  // returns the entire concatenated buffer string.
  self.take = function(n, encoding) {
    if (n == undefined) n = self.length;
    else if (typeof n !== 'number') {
      encoding = n;
      n = self.length;
    }
    if (!encoding) encoding = self.encoding;
    if (encoding) {
      var acc = '';
      self.forEach(function(buffer) {
        if (n <= 0) return true;
        acc += buffer.toString(encoding, 0, Math.min(n, buffer.length));
        n -= buffer.length;
      });
      return acc;
    } else {
      // If no 'encoding' is specified, then return a Buffer.
      return self.join(0, n);
    }
  };

  // The entire concatenated buffer as a string.
  self.toString = function() {
    return self.take('binary');
  };
}
require('util').inherits(BufferQueue, EventEmitter);

