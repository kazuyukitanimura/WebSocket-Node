/************************************************************************
 *  Copyright 2010-2011 Worlize Inc.
 *  
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *  
 *      http://www.apache.org/licenses/LICENSE-2.0
 *  
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ***********************************************************************/

var ctio = require('../vendor/node-ctype/ctio-faster');

const DECODE_HEADER = 1;
const WAITING_FOR_16_BIT_LENGTH = 2;
const WAITING_FOR_64_BIT_LENGTH = 3;
const WAITING_FOR_MASK_KEY = 4;
const WAITING_FOR_PAYLOAD = 5;
const COMPLETE = 6;

// WebSocketConnection will pass shared buffer objects for maskBytes and
// frameHeader into the constructor to avoid tons of small memory allocations
// for each frame we have to parse.  This is only used for parsing frames
// we receive off the wire.
function WebSocketFrame(maskBytes, frameHeader, config) {
    this.maskBytes = maskBytes;
    this.frameHeader = frameHeader;
    this.config = config;
    this.maxReceivedFrameSize = config.maxReceivedFrameSize;
    this.protocolError = false;
    this.frameTooLarge = false;
    this.invalidCloseFrameLength = false;
    this.parseState = DECODE_HEADER;
    this.closeStatus = -1;
}

WebSocketFrame.prototype.addData = function(buffer, fragmentationType) {
    var temp;
    if (this.parseState === DECODE_HEADER) {
        if (buffer.length >= 2) {
            this.frameHeader[0] = buffer[0];
            this.frameHeader[1] = buffer[1];
            buffer.advance(2);
            var firstByte = this.frameHeader[0];
            var secondByte = this.frameHeader[1];

            this.fin     = Boolean(firstByte  & 0x80);
            this.rsv1    = Boolean(firstByte  & 0x40);
            this.rsv2    = Boolean(firstByte  & 0x20);
            this.rsv3    = Boolean(firstByte  & 0x10);
            this.mask    = Boolean(secondByte & 0x80);

            this.opcode  = firstByte  & 0x0F;
            this.length = secondByte & 0x7F;
            
            // Control frame sanity check
            if (this.opcode >= 0x08) {
                if (this.length > 125) {
                    this.protocolError = true;
                    this.dropReason = "Illegal control frame longer than 125 bytes.";
                    return true;
                }
                if (!this.fin) {
                    this.protocolError = true;
                    this.dropReason = "Control frames must not be fragmented.";
                    return true;
                }
            }
            
            if (this.length === 126) {
                this.parseState = WAITING_FOR_16_BIT_LENGTH;
            }
            else if (this.length === 127) {
                this.parseState = WAITING_FOR_64_BIT_LENGTH;
            }
            else {
                this.parseState = WAITING_FOR_MASK_KEY;
            }
        }
    }
    if (this.parseState === WAITING_FOR_16_BIT_LENGTH) {
        if (buffer.length >= 2) {
            this.frameHeader[2] = buffer[0];
            this.frameHeader[3] = buffer[1];
            buffer.advance(2);
            this.length = ctio.ruint16(this.frameHeader, 'big', 2);
            this.parseState = WAITING_FOR_MASK_KEY;
        }
    }
    else if (this.parseState === WAITING_FOR_64_BIT_LENGTH) {
        if (buffer.length >= 8) {
            this.frameHeader[2] = buffer[0];
            this.frameHeader[3] = buffer[1];
            this.frameHeader[4] = buffer[2];
            this.frameHeader[5] = buffer[3];
            this.frameHeader[6] = buffer[4];
            this.frameHeader[7] = buffer[5];
            this.frameHeader[8] = buffer[6];
            this.frameHeader[9] = buffer[7];
            buffer.advance(8);
            var lengthPair = ctio.ruint64(this.frameHeader, 'big', 2);
            if (lengthPair[0] !== 0) {
                this.protocolError = true;
                this.dropReason = "Unsupported 64-bit length frame received";
                return true;
            }
            this.length = lengthPair[1];
            this.parseState = WAITING_FOR_MASK_KEY;
        }
    }
    
    if (this.parseState === WAITING_FOR_MASK_KEY) {
        if (this.mask) {
            if (buffer.length >= 4) {
                this.maskBytes[0] = buffer[0];
                this.maskBytes[1] = buffer[1];
                this.maskBytes[2] = buffer[2];
                this.maskBytes[3] = buffer[3];
                buffer.advance(4);
                this.maskPos = 0;
                this.parseState = WAITING_FOR_PAYLOAD;
            }
        }
        else {
            this.parseState = WAITING_FOR_PAYLOAD;
        }
    }
    
    if (this.parseState === WAITING_FOR_PAYLOAD) {
        if (this.length > this.maxReceivedFrameSize) {
            this.frameTooLarge = true;
            this.dropReason = "Frame size of " + this.length.toString(10) +
                              " bytes exceeds maximum accepted frame size";
            return true;
        }
        
        if (this.length === 0) {
            this.binaryPayload = new Buffer(0);
            this.parseState = COMPLETE;
            return true;
        }
        if (buffer.length >= this.length) {
            this.binaryPayload = buffer.slice(0, this.length);
            buffer.advance(this.length);
            if (this.mask) {
                this.applyMask(this.binaryPayload, 0, this.length);
            }
            
            if (this.opcode === 0x08) { // WebSocketOpcode.CONNECTION_CLOSE
                if (this.length === 1) {
                    // Invalid length for a close frame.  Must be zero or at least two.
                    this.binaryPayload = new Buffer(0);
                    this.invalidCloseFrameLength = true;
                }
                if (this.length >= 2) {
                    this.closeStatus = ctio.ruint16(this.binaryPayload, 'big', 0);
                    this.binaryPayload = this.binaryPayload.slice(2);
                }
            }
            
            this.parseState = COMPLETE;
            return true;
        }
    }
    return false;
};

WebSocketFrame.prototype.throwAwayPayload = function(buffer) {
    if (buffer.length >= this.length) {
        buffer.advance(this.length);
        this.parseState = COMPLETE;
        return true;
    }
    return false;
};

WebSocketFrame.prototype.applyMask = function(buffer, offset, length) {
    var end = offset + length;
    for (var i=offset; i < end; i++) {
        buffer[i] = buffer[i] ^ this.maskBytes[this.maskPos];
        this.maskPos = (this.maskPos + 1) & 3;
    }
};

WebSocketFrame.prototype.toBuffer = function(nullMask) {
    var maskKey;
    var headerLength = 2;
    var data;
    var outputPos;
    var firstByte = 0x00;
    var secondByte = 0x00;
    
    if (this.fin) {
        firstByte |= 0x80;
    }
    if (this.rsv1) {
        firstByte |= 0x40;
    }
    if (this.rsv2) {
        firstByte |= 0x20;
    }
    if (this.rsv3) {
        firstByte |= 0x10;
    }
    if (this.mask) {
        secondByte |= 0x80;
    }

    firstByte |= (this.opcode & 0x0F);

    // the close frame is a special case because the close reason is
    // prepended to the payload data.
    if (this.opcode === 0x08) {
        this.length = 2;
        if (this.binaryPayload) {
            this.length += this.binaryPayload.length;
        }
        data = new Buffer(this.length);
        ctio.wuint16(this.closeStatus, 'big', data, 0);
        if (this.length > 2) {
            this.binaryPayload.copy(data, 2);
        }
    }
    else if (this.binaryPayload) {
        data = this.binaryPayload;
        this.length = data.length;
    }
    else {
        this.length = 0;
    }

    if (this.length <= 125) {
        // encode the length directly into the two-byte frame header
        secondByte |= (this.length & 0x7F);
    }
    else if (this.length > 125 && this.length <= 0xFFFF) {
        // Use 16-bit length
        secondByte |= 126;
        headerLength += 2;
    }
    else if (this.length > 0xFFFF) {
        // Use 64-bit length
        secondByte |= 127;
        headerLength += 8;
    }

    output = new Buffer(this.length + headerLength + (this.mask ? 4 : 0));

    // write the frame header
    output[0] = firstByte;
    output[1] = secondByte;

    outputPos = 2;
    
    if (this.length > 125 && this.length <= 0xFFFF) {
        // write 16-bit length
        ctio.wuint16(this.length, 'big', output, outputPos);
        outputPos += 2;
    }
    else if (this.length > 0xFFFF) {
        // write 64-bit length
        ctio.wuint64([0x00000000, this.length], 'big', output, outputPos);
        outputPos += 8;
    }
    
    if (this.length > 0) {
        if (this.mask) {
            if (!nullMask) {
                // Generate a mask key
                maskKey = parseInt(Math.random()*0xFFFFFFFF);
            }
            else {
                maskKey = 0x00000000;
            }
            ctio.wuint32(maskKey, 'big', this.maskBytes, 0);
            this.maskPos = 0;

            // write the mask key
            this.maskBytes.copy(output, outputPos);
            outputPos += 4;
        
            data.copy(output, outputPos);
            this.applyMask(output, outputPos, data.length);
        }
        else {
            data.copy(output, outputPos);
        }
    }
    
    return output;
};
    
WebSocketFrame.prototype.toString = function() {
    return "Opcode: " + this.opcode + ", fin: " + this.fin + ", length: " + this.length + ", hasPayload: " + Boolean(this.binaryPayload) + ", masked: " + this.mask;
};


module.exports = WebSocketFrame;
