const through            = require('through'),
      packetize          = require('stream-packetize'),
      serializeError     = require('serialize-error'),
      nagle              = require('stream-nagle'),
      stream             = Symbol('stream'),
      isBuffer           = require('is-buffer');

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
  out      = out  || [];
  path     = path || [];

  let type = 1;
  Object.keys(data).forEach(function(key) {
    let current = [path.concat([key]), typeof data[key]];
    switch(current[type]) {
      case 'function':
        if (includeFn) current.push(data[key]);
        out.push(current);
        serialize(data[key], out, path.concat([key]), includeFn);
        break;
      case 'object':

        // null = object
        if (null === data[key]) {
          current[type] = 'null';
          out.push(current);
          break;
        }

        // Identify arrays
        if (Array.isArray(data[key])) {
          current[type] = 'array';
        }

        // Iterate down
        out.push(current);
        serialize(data[key], out, path.concat([key]), includeFn);
        break;
      default:
        current.push(data[key]);
        out.push(current);
        break;
    }
  });
  return out;
}

function deserialize( ref, data, obj ) {
  obj   = obj || {};
  let s = ref[stream];
  data.forEach(function(token) {

    // Destructure the token
    let [path, type, value] = token;
    let ref                 = obj;
    let lastKey             = path.pop();

    // Follow path into object
    for (const key of path) {
      ref = ref[key] = ref[key] || {};
    }

    // Fetch what to do
    switch(type) {
      case 'null':
        ref[lastKey] = null;
        return;
      case 'object':
        if ('object' !== typeof ref[lastKey])
          ref[lastKey] = {};
        return;
      case 'array':
        if (!Array.isArray(ref[lastKey]))
          ref[lastKey] = [];
        return;
      case 'callback':
        return ref[lastKey] = function(...args) {
          s.output.write(encode({
            ret : value,
            arg : serializeArgs(s,args),
          }));
        };
      case 'function':
        if (!value) value = path.concat([lastKey]);
        if (!Array.isArray(value)) value = [value];
        return ref[lastKey] = function (...args) {
          return new Promise((resolve, reject) => {
            let callId = genId();
            s.tmp[callId] = function( err, data ) {
              delete s.tmp[callId];
              if (err) return reject(new RemoteError(err));
              resolve(data);
            };
            s.output.write(encode({
              fn : value,
              id : callId,
              arg: serializeArgs(s, args),
            }));
          });
        };
      default:
        if (value !== ref[lastKey])
          ref[lastKey] = value;
        return;
    }
  });
  return obj;
}

function serializeArgs(ref, data) {
  let s = ref[stream];
  let serialized = serialize(data, [], [], true);
  serialized.forEach(function(token) {
    switch(token[1]) {
      case 'function':
        let fn = token[2];
        let id = genId();
        s.tmp[id] = function(...args) {
          delete s.tmp[id]
          fn(...args);
        };
        token[1]  = 'callback';
        token[2]  = id;
        break;
    }
  });
  return serialized;
}

function deserializeArgs(ref, data) {
  let deserialized = deserialize(ref, data);
  return Object.keys(deserialized).map( key => deserialized[key] );
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
  const io     = through(function (data) {
    input.write(data);
  }, function() {
    input.write(null);
  });
  output.pipe(nagle(opts))
    .on('data', function(chunk) {
      io.queue(chunk);
    })
    .on('end', function() {
      io.queue(null);
      io.emit('close');
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
      return io.tmp[data.ret](...deserializeArgs(io,data.arg));
    }

    // Handle local functions
    if (Array.isArray(data.fn)) {
      let target = io.local;
      for( let key of data.fn )
        target = target[key] || {};
      if ('function' !== typeof target) return;
      try {
        let result = await target(...deserializeArgs(io,data.arg));
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
