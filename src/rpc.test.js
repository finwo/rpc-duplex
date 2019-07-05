const rpc  = require('./rpc');
const test = require('tape');

// Build server
const serverSide = rpc({}, {
  ready: true,
  secret: null,
  user: {
    name: 'root',
    pass: 'toor'
  },
  fnReturn: function(arg) {
    return arg.toUpperCase();
  },
  fnCallback: function(arg, cb) {
    cb(null,arg.toUpperCase());
  },
  fnThrow: function() {
    throw new Error('foobar err');
  },
  config: {
    regex: {
      ip : /((^\s*((([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5]))\s*$)|(^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*$))/i,
    }
  }
});

// Init client connector
const clientSide = rpc({});

// Connect them together (would normally go through net)
serverSide.pipe(clientSide).pipe(serverSide);

// Initialize the actual client
const client = rpc.remote(clientSide);

test('Wait for client ready', async t => {
  t.plan(1);
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
  t.equal(client.ready,true, 'client.ready = true');
});

test('Verify received types', async t => {
  t.plan(12);
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
  t.equal(typeof client.ready          , 'boolean' , 'typeof client.ready           = boolean' );
  t.equal(typeof client.config         , 'object'  , 'typeof client.config          = object'  );
  t.equal(typeof client.config.regex   , 'object'  , 'typeof client.config.regex    = object'  );
  t.equal(typeof client.config.regex.ip, 'object'  , 'typeof client.config.regex.ip = object'  );
  t.equal(typeof client.secret         , 'object'  , 'typeof client.secret          = object'  );
  t.equal(typeof client.user           , 'object'  , 'typeof client.user            = object'  );
  t.equal(typeof client.user.name      , 'string'  , 'typeof client.user.name       = string'  );
  t.equal(typeof client.user.pass      , 'string'  , 'typeof client.user.pass       = string'  );
  t.equal(typeof client.fnReturn       , 'function', 'typeof client.fnReturn        = function');
  t.equal(typeof client.fnCallback     , 'function', 'typeof client.fnCallback      = function');
  t.equal(typeof client.fnThrow        , 'function', 'typeof client.fnThrow         = function');
  t.equal(client.config.regex.ip instanceof RegExp, true, 'client.config.regex.ip = RegExp');
});

test('Verify string values', async t => {
  t.plan(2);
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
  t.equal(client.user.name, 'root', 'client.user.name = root');
  t.equal(client.user.pass, 'toor', 'client.user.pass = toor');
});

test('Returning function', async t => {
  t.plan(1);
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
  let result = await client.fnReturn('foobar');
  t.equal(result, 'FOOBAR', 'fnReturn returned uppercase version of input through promise');
});

test('Callback function', async t => {
  t.plan(1);
  while(!client.ready) await new Promise(r=>setTimeout(r,10));

  let result = await new Promise((resolve,reject) => {
    client.fnCallback('hello world', function(err, data) {
      if (err) return reject(err);
      resolve(data);
    });
  });

  t.equal(result, 'HELLO WORLD', 'fnCallback returned uppercase version of input through callback');
});

test('Throwing function', async t => {
  t.plan(2);
  while (!client.ready) await new Promise(r=>setTimeout(r,10));

  let thrown = false;
  try {
    await client.fnThrow();
  } catch(e) {
    thrown = e;
  }
  t.equal(!!thrown      , true        , 'an error was thrown'       );
  t.equal(thrown.message, 'foobar err', 'error message was expected');
});

test('Check if synchronized RegEx still works', async t => {
  t.plan(5);
  while(!client.config.regex.ip) await new Promise(r=>setTimeout(r,10));

  let regex = client.config.regex.ip;
  t.equal(regex.test('127.0.0.1'      ), true , 'valid:   127.0.0.1'      );
  t.equal(regex.test('::1'            ), true , 'valid:   ::1'            );
  t.equal(regex.test(':::1'           ), false, 'invalid: :::1'           );
  t.equal(regex.test('256.255.255.255'), false, 'invalid: 256.255.255.255');
  t.equal(regex.test('255.255.255.255'), true , 'valid:   255.255.255.255');
});
