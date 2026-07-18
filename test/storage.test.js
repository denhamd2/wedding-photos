'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { create, R2Driver } = require('../lib/storage');

const creds = { accessKeyId: 'k', secretAccessKey: 's', bucket: 'johnkatiewedding' };

test('R2 endpoint defaults to the account host', () => {
  const d = new R2Driver({ ...creds, accountId: '460c4bcf1a747dca96bc6bed6305d975' });
  assert.equal(d.endpoint, 'https://460c4bcf1a747dca96bc6bed6305d975.r2.cloudflarestorage.com');
});

test('R2_ENDPOINT override wins (for EU-jurisdiction buckets), trailing slash stripped', () => {
  const d = new R2Driver({
    ...creds,
    accountId: '460c4bcf1a747dca96bc6bed6305d975',
    endpoint: 'https://460c4bcf1a747dca96bc6bed6305d975.eu.r2.cloudflarestorage.com/',
  });
  assert.equal(d.endpoint, 'https://460c4bcf1a747dca96bc6bed6305d975.eu.r2.cloudflarestorage.com');
});

test('create() with r2 driver reports missing env vars by name', () => {
  assert.throws(
    () => create({ STORAGE_DRIVER: 'r2', R2_ACCOUNT_ID: 'abc' }),
    /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET/,
  );
});
