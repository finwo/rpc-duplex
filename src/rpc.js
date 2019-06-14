const packetize          = require('stream-packetize'),
      serializeError     = require('serialize-error'),
      nagle              = require('stream-nagle'),
      stream             = Symbol('stream'),
      EventEmitter       = require('simple-ee');

function encode( subject ) {
  return JSON.stringify(subject);
}

function decode( subject ) {
  try {
    return JSON.parse(subject, (k,v) => {
      if (  'object' !== typeof v      ) return v;
      if (                     !v      ) return v;
      if (!('type'   in         v     )) return v;
      if (  'Buffer' !==        v.type ) return v;
      if (!('data'   in         v     )) return v;
      if (! Array.isArray(v.data      )) return v;
      return Buffer.from(v.data);
    });
  } catch(e) {
    console.error(e);
  }
}

// Generate a safe ID to use
function genId() {
  let out = '';
  while (out.length < 48)
    out += Math.floor(Math.random() * 36).toString(36);
  return out;
}

// Remotely-thrown errors will be of this class
class RemoteError extends Error {
  constructor(data) {
    super();
    Object.assign(this, data);
  }
}

// Attach the stream everywhere in the ref
function attachStream( obj, s ) {
  if (!obj) return;
  if (!s) return;
  if ('object' === typeof obj) {
    Object.defineProperty(obj, stream, {
      enumerable  : false,
      configurable: true,
      get         : () => s,
      set         : () => {},
    });
  }
  for (let prop in obj) {
    if (!obj.hasOwnProperty(prop)) continue;
    if (prop === stream) continue;
    switch (typeof obj[prop]) {
      case 'object':
      case 'function':
        if (!obj[prop]) continue;
        Object.defineProperty(obj[prop], stream, {
          enumerable  : false,
          configurable: true,
          get         : () => s,
          set         : () => {},
        });
        break;
    }
  }
}

function serialize( data, out, path, includeFn ) {
  out      = out  || [Array.isArray(data)?[]:{},[]];
  path     = path || [];

  let type = 1;
  Object.keys(data).forEach(function(key) {
    let current = path.concat([key]);
    switch(typeof data[key]) {
      case 'function':
        let fn = [current];
        if (includeFn) fn.push(data[key]);
        out[1].push(fn);
        out[0][key] = {};
        serialize(data[key], [out[0][key],out[1]], path.concat([key]), includeFn);
        break;
      case 'object':

        // Null
        if (!data[key])
          return out[0][key] = data[key];

        // Iterate down
        out[0][key] = data[key];
        serialize(data[key], [out[0][key],out[1]], current, includeFn);
        return;
      default:
        out[0][key] = data[key];
        break;
    }
  });
  return out;
}

function deserialize( ref, data, obj ) {
  let s = ref[stream];
  obj   = obj || (Array.isArray(data[0])?[]:{});

  (function merge(dst, src, path) {
    Object.keys(src).forEach(function(key) {
      let current = path.concat([key]);
      let type    = typeof src[key];
      switch(type) {
        case 'object':
          if (!src[key]) return dst[key] = src[key];
          dst[key] = dst[key] || (Array.isArray(src[key])?[]:{});
          merge(dst[key],src[key],current);
        default:
          dst[key] = src[key];
          break;
      }
    });
  })(obj,data[0],[]);

  (function insertFunction(dst,fn) {
    fn.forEach(function([path,id]) {
          path  = path.slice();
      let value = path.slice();
      let ref   = dst;
      let last  = path.pop();
      for(let token in path)
        ref = ref[token] = ref[token] || {};
      let org = ref[last];
      ref[last] = function(...args) {
        const callId = genId();
        return new Promise((resolve,reject) => {
          s.tmp[callId] = (err,data) => {
            delete s.tmp[callId];
            if(err) return reject(err);
            resolve(data);
          };
          let data = {id:callId,arg:serializeArgs(s,args)};
          if (id) data.ret = id;
          else data.fn = value;
          s.output.write(encode(data));
        });
      };
      Object.assign(ref[last],org);
    });
  })(obj,data[1]);

  return obj;
}

function serializeArgs(ref, data) {
  let s = ref[stream];
  let serialized = serialize(data, null, null, true);
  serialized[1].forEach(function(token) {
    let id    = genId();
    s.tmp[id] = token[1];
    token[1]  = id;
  });
  return serialized;
}

const rpc = module.exports = function (options, local, remote) {
  let opts = Object.assign({
    aggressive:  true,
    base64    :  false,
    burst     :  true,
    mtu       :  2048,
    wait      :    10,
    keepalive : 10000,
  }, options || {});

  // Ensure local & remote objects
  local      = local  || {};
  remote     = remote || {};

  // Create IO loop
  const input  = packetize.decode(opts);
  const output = packetize.encode(opts);
  const io     = EventEmitter({
    readable: true,
    writable: true,
    paused  : false,
    write   : function(data) {
      input.write(data);
    },
    end     : function(data) {
      input.write(null);
      this.emit('end');
    },
    pipe    : function(destination) {
      this.on('data',function(data) {
        destination.write(data);
      });
      return destination;
    },
  });
  output.pipe(nagle(opts))
    .on('data', function(chunk) {
      io.emit('data',chunk);
    })
    .on('end', function() {
      io.emit('data',null);
    });

  // Internal functions
  const internal = {
    state: function() {
      return io.output.write(encode({fn:'update',arg:[serialize(io.local)]}));
    },
    update: function( serialized ) {
      deserialize(io,serialized,io.remote);
      return io.emit('update');
    },
  };

  // Handle incoming data
  input.on('data', async function(data) {
    if (!data) return;
    data = decode(data);

    // Handle internal functions
    if (('string' === typeof data.fn) && (data.fn in internal)) {
      return internal[data.fn](...(data.arg||[]));
    }

    // Handle function returns
    if (('string' === typeof data.ret) && (data.ret in io.tmp)) {
      return io.tmp[data.ret](...deserialize(io,data.arg));
    }

    // Handle local functions
    if (Array.isArray(data.fn)) {
      let target = io.local;
      for( let key of data.fn )
        target = target[key] || {};
      if ('function' !== typeof target) return;
      try {
        let result = await target(...deserialize(io,data.arg));
        return io.output.write(encode({
          ret : data.id,
          arg : serializeArgs(io,[null,result]),
        }));
      } catch(e) {
        return io.output.write(encode({
          ret : data.id,
          arg : serializeArgs(io,[serializeError(e)]),
        }));
      }
    }
  });

  // Attach references
  io.local   = local;
  io.remote  = remote;
  io.output  = output;
  io.input   = input;
  io.tmp     = {};
  io[stream] = io;
  attachStream(io.remote,io);
  attachStream(io.local ,io);
 
  // Return the duplex
  return io;
};

rpc.remote = function (ref) {
  rpc.update(ref);
  return ref[stream].remote;
};

rpc.local = function(ref) {
  return ref[stream].local;
};

rpc.update = function(ref) {
  if (!ref[stream]) return;
  ref[stream].output.write(encode({fn:'state'}));
};

rpc.updateRemote = function(ref) {
  if (!ref[stream]) return;
  attachStream(ref,ref[stream]);
  ref[stream].input.emit('data',encode({fn: 'state'}));
};
