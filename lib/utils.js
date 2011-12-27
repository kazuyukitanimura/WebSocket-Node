module.exports = {
    extend: function extend(dest, source) {
        for (var prop in source) {
            dest[prop] = source[prop];
        }
    }
};

Buffer.prototype.advance = function (n) {
  this.offset +=n;
  this.length -=n;
};
