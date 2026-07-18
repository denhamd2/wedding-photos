'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Two drivers behind one interface:
//   r2    — Cloudflare R2 via the S3 API (production)
//   local — plain filesystem (development/tests)
// Interface: putObject, getObject, headObject, deleteObject, listAll
// putObject accepts a Buffer or a stream; streams must pass contentLength.

class LocalDriver {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _path(key) {
    const p = path.normalize(path.join(this.dir, key));
    if (!p.startsWith(this.dir + path.sep)) throw new Error('invalid key');
    return p;
  }

  async putObject(key, body, contentType) {
    const p = this._path(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body); // accepts Buffers and (async) iterables/streams
    await fsp.writeFile(p + '.ct', contentType || 'application/octet-stream');
  }

  async getObject(key) {
    const p = this._path(key);
    const contentType = await fsp.readFile(p + '.ct', 'utf8').catch(() => 'application/octet-stream');
    const stat = await fsp.stat(p);
    return { body: fs.createReadStream(p), contentType, contentLength: stat.size };
  }

  async headObject(key) {
    const stat = await fsp.stat(this._path(key));
    return { contentLength: stat.size };
  }

  async deleteObject(key) {
    await fsp.rm(this._path(key), { force: true });
    await fsp.rm(this._path(key) + '.ct', { force: true });
  }

  async listAll(prefix) {
    const out = [];
    const base = this.dir;
    async function walk(dir) {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith('.ct')) {
          const key = path.relative(base, full).split(path.sep).join('/');
          if (key.startsWith(prefix)) out.push({ key, size: (await fsp.stat(full)).size });
        }
      }
    }
    await walk(base);
    return out;
  }

}

class R2Driver {
  constructor({ accountId, accessKeyId, secretAccessKey, bucket, endpoint }) {
    const { S3Client } = require('@aws-sdk/client-s3');
    this.bucket = bucket;
    // Jurisdiction-restricted buckets (e.g. EU) live on a different host than the
    // account default, so an explicit endpoint takes precedence.
    this.endpoint = (endpoint || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
    this.client = new S3Client({
      region: 'auto',
      endpoint: this.endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async putObject(key, body, contentType, contentLength) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // streams need an explicit length for a single-part S3 PUT
      ...(contentLength ? { ContentLength: contentLength } : {}),
    }));
  }

  async getObject(key) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { body: res.Body, contentType: res.ContentType, contentLength: res.ContentLength };
  }

  async headObject(key) {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return { contentLength: res.ContentLength };
  }

  async deleteObject(key) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async listAll(prefix) {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const out = [];
    let token;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: prefix, ContinuationToken: token,
      }));
      for (const obj of res.Contents || []) out.push({ key: obj.Key, size: obj.Size });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

}

function create(env = process.env) {
  const driver = env.STORAGE_DRIVER || (env.R2_ACCOUNT_ID ? 'r2' : 'local');
  if (driver === 'local') {
    return { driver: 'local', ...wrap(new LocalDriver(path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')))) };
  }
  const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing env vars for R2 storage: ${missing.join(', ')}`);
  return {
    driver: 'r2',
    ...wrap(new R2Driver({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      endpoint: env.R2_ENDPOINT,
    })),
  };
}

function wrap(impl) {
  return {
    putObject: impl.putObject.bind(impl),
    getObject: impl.getObject.bind(impl),
    headObject: impl.headObject.bind(impl),
    deleteObject: impl.deleteObject.bind(impl),
    listAll: impl.listAll.bind(impl),
  };
}

module.exports = { create, LocalDriver, R2Driver };
