var esmRequire = require('esm')(module);
var expect     = esmRequire('expect');
var rpc        = esmRequire('./rpc');

var serverSide;
var clientSide;
var client;

beforeAll(async function() {

  // Build server
  serverSide = rpc({}, {
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
  });

  // Init client connector
  clientSide = rpc({});

  // Connect them together (would normally go through net)
  serverSide.pipe(clientSide).pipe(serverSide);

  // Initialize the actual client
  client = rpc.remote(clientSide);
});

afterAll(async function() {
  await new Promise(r=>setTimeout(r,1000));
  console.log(clientSide.tmp);
});

test('Wait for client ready', async () => {
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
  expect(client.ready).toBe(true);
});

test('Verify received types', async () => {
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
  expect(typeof client.ready     ).toBe('boolean');
  expect(typeof client.secret    ).toBe('object');
  expect(typeof client.user      ).toBe('object');
  expect(typeof client.user.name ).toBe('string');
  expect(typeof client.user.pass ).toBe('string');
  expect(typeof client.fnReturn  ).toBe('function');
  expect(typeof client.fnCallback).toBe('function');
  expect(typeof client.fnThrow   ).toBe('function');
});

test('Verify string values', async () => {
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
  expect(client.user.name).toBe('root');
  expect(client.user.pass).toBe('toor');
});

test('Returning function', async () => {
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
  let result = await client.fnReturn('foobar');
  expect(result).toBe('FOOBAR');
});

test('Callback function', async () => {
  while(!client.ready) await new Promise(r=>setTimeout(r,10));
 
  let result = await new Promise((resolve,reject) => {
    client.fnCallback('hello world', function(err, data) {
      if (err) return reject(err);
      resolve(data);
    });
  });
  expect(result).toBe('HELLO WORLD');
});

test('Throwing function', async () => {
  while (!client.ready) await new Promise(r=>setTimeout(r,10));

  let thrown = false;
  try {
    await client.fnThrow();
  } catch(e) {
    thrown = e;
  }
  expect(thrown).toBeTruthy();
  expect(thrown.message).toBe('foobar err');
});

