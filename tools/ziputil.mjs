// 极简 ZIP 读写工具（专为跨平台打包 macOS .app 设计）
//
// 为什么需要它：本机（Windows）无法创建符号链接（EPERM），而 macOS 的 Electron
// 应用包内部依赖符号链接（Electron Framework 的 Versions/Current 等）。
// 因此不走「解压再打包」，而是直接读取 Electron zip 的条目元数据，
// 改写路径后写入新 zip；符号链接条目以真正的 Unix symlink 形式写入
// （外部属性 = S_IFLNK | 0777），在 macOS 上解压时会被正确还原为符号链接。

import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOCATOR = 0x07064b50;

/** 读取整个 zip 的条目表（含 Unix 模式、符号链接判定）。 */
export function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD 未找到: ' + file);

  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOff = buf.readUInt32LE(eocd + 16);

  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
    const locOff = eocd - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === SIG_Z64_LOCATOR) {
      const z64 = Number(buf.readBigUInt64LE(locOff + 8));
      if (buf.readUInt32LE(z64) === SIG_Z64_EOCD) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdSize = Number(buf.readBigUInt64LE(z64 + 40));
        cdOff = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('中央目录损坏 @' + p);
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const mode = (externalAttrs >>> 16) & 0xffff;
    entries.push({
      name, method, flags, crc, compSize, uncompSize,
      externalAttrs, versionMadeBy, localOffset, mode,
      isSymlink: (mode & 0xf000) === 0xa000,
      isDir: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

/** 取出某条目的原始数据（自动解压）。 */
export function entryData(zip, e) {
  const { buf } = zip;
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error('本地头损坏: ' + e.name);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式 ' + e.method + ': ' + e.name);
}

/** 取出某条目的「原始压缩数据」（不解压），用于原样搬运。 */
export function entryRaw(zip, e) {
  const { buf } = zip;
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error('本地头损坏: ' + e.name);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  return buf.subarray(start, start + e.compSize);
}

/**
 * 流式 ZIP 写入器。
 * - 文件权限与符号链接通过外部属性表达（Unix, versionMadeBy 高字节 = 3）
 * - 大文件用 store（不压缩）+ 分块读取，避免占满内存
 * - 条目数超过 65535 时自动写 ZIP64 结束记录
 */
export class ZipWriter {
  constructor(outPath) {
    this.fd = fs.openSync(outPath, 'w');
    this.offset = 0;
    this.central = [];
  }

  _write(buf) {
    fs.writeSync(this.fd, buf, 0, buf.length);
    this.offset += buf.length;
  }

  _localHeader(nameBuf, method, crc, compSize, uncompSize, dosTime, dosDate) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(20, 4);            // version needed
    h.writeUInt16LE(0x0800, 6);        // UTF-8 文件名标志
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(dosTime, 10);
    h.writeUInt16LE(dosDate, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(compSize, 18);
    h.writeUInt32LE(uncompSize, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    return h;
  }

  _record(name, nameBuf, method, crc, compSize, uncompSize, mode, isDir, dosTime, dosDate, localOffset) {
    this.central.push({ name, nameBuf, method, crc, compSize, uncompSize, mode, isDir, dosTime, dosDate, localOffset });
  }

  /** 写入一个普通文件（小文件：整块压缩）。 */
  addBuffer(name, data, mode = 0o100644) {    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const uncompSize = data.length;
    let method = 0;
    let out = data;
    if (data.length > 0) {
      const def = zlib.deflateRawSync(data, { level: 6 });
      if (def.length < data.length) { method = 8; out = def; }
    }
    const { time, date } = dosNow();
    const localOffset = this.offset;
    this._write(this._localHeader(nameBuf, method, crc, out.length, uncompSize, time, date));
    this._write(nameBuf);
    this._write(out);
    this._record(name, nameBuf, method, crc, out.length, uncompSize, mode, false, time, date, localOffset);
  }

  /**
   * 原样搬运一个已压缩条目：不重新压缩，直接复用源 zip 的压缩数据与 CRC。
   * 用于把 Electron 的条目（含 192MB 的 Framework）快速拷进新 zip。
   */
  addRaw(name, rawCompressed, method, crc, uncompSize, mode = 0o100644) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosNow();
    const localOffset = this.offset;
    this._write(this._localHeader(nameBuf, method, crc, rawCompressed.length, uncompSize, time, date));
    this._write(nameBuf);
    this._write(rawCompressed);
    this._record(name, nameBuf, method, crc, rawCompressed.length, uncompSize, mode, false, time, date, localOffset);
  }

  /** 写入一个大文件（store 方式，分块读取，不驻留内存）。 */
  addFileFromPath(name, srcPath, mode = 0o100644) {
    const nameBuf = Buffer.from(name, 'utf8');
    const size = fs.statSync(srcPath).size;
    // 第一遍：计算 CRC
    const CHUNK = 4 * 1024 * 1024;
    const rbuf = Buffer.alloc(CHUNK);
    const rfd = fs.openSync(srcPath, 'r');
    let crc = 0;
    let read;
    while ((read = fs.readSync(rfd, rbuf, 0, CHUNK, null)) > 0) {
      crc = zlib.crc32(rbuf.subarray(0, read), crc);
    }
    fs.closeSync(rfd);

    const { time, date } = dosNow();
    const localOffset = this.offset;
    this._write(this._localHeader(nameBuf, 0, crc, size, size, time, date));
    this._write(nameBuf);
    // 第二遍：流式写入内容
    const rfd2 = fs.openSync(srcPath, 'r');
    const cbuf = Buffer.alloc(CHUNK);
    let n;
    while ((n = fs.readSync(rfd2, cbuf, 0, CHUNK, null)) > 0) {
      fs.writeSync(this.fd, cbuf, 0, n);
      this.offset += n;
    }
    fs.closeSync(rfd2);
    this._record(name, nameBuf, 0, crc, size, size, mode, false, time, date, localOffset);
  }

  /** 写入一个 Unix 符号链接条目（data = 链接目标）。 */
  addSymlink(name, target, mode = 0o120777) {
    this.addBuffer(name, Buffer.from(target, 'utf8'), mode);
  }

  /** 写入目录条目。 */
  addDir(name) {
    const n = name.endsWith('/') ? name : name + '/';
    const nameBuf = Buffer.from(n, 'utf8');
    const { time, date } = dosNow();
    const localOffset = this.offset;
    this._write(this._localHeader(nameBuf, 0, 0, 0, 0, time, date));
    this._write(nameBuf);
    this._record(n, nameBuf, 0, 0, 0, 0, 0o040755, true, time, date, localOffset);
  }

  finalize() {
    const cdStart = this.offset;
    for (const e of this.central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(0x031e, 4);        // versionMadeBy: Unix(3) + 30
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.dosTime, 12);
      h.writeUInt16LE(e.dosDate, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compSize, 20);
      h.writeUInt32LE(e.uncompSize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      // 外部属性：高 16 位是 Unix 模式；目录置低位 0x10
      const ext = ((e.mode & 0xffff) << 16) | (e.isDir ? 0x10 : 0);
      h.writeUInt32LE(ext >>> 0, 38);
      h.writeUInt32LE(e.localOffset, 42);
      this._write(h);
      this._write(e.nameBuf);
    }
    const cdSize = this.offset - cdStart;
    const count = this.central.length;

    const needZip64 = count > 0xffff || cdStart > 0xffffffff || cdSize > 0xffffffff;
    if (needZip64) {
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(SIG_Z64_EOCD, 0);
      z64.writeBigUInt64LE(BigInt(44), 4);
      z64.writeUInt16LE(0x031e, 12);
      z64.writeUInt16LE(45, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      z64.writeBigUInt64LE(BigInt(count), 24);
      z64.writeBigUInt64LE(BigInt(count), 32);
      z64.writeBigUInt64LE(BigInt(cdSize), 40);
      z64.writeBigUInt64LE(BigInt(cdStart), 48);
      const z64Off = this.offset;
      this._write(z64);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_Z64_LOCATOR, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(z64Off), 8);
      loc.writeUInt32LE(1, 16);
      this._write(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Math.min(count, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(count, 0xffff), 10);
    eocd.writeUInt32LE(Math.min(cdSize, 0xffffffff), 12);
    eocd.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);

    fs.closeSync(this.fd);
    return { count, cdStart, cdSize, totalSize: this.offset };
  }
}

function dosNow() {
  const d = new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}
