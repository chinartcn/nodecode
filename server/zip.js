/**
 * 最小 ZIP 读取器（零第三方依赖）。
 *
 * 支持：
 * - Store（method 0）与 Deflate（method 8）
 * - 中央目录解析，兼容带数据描述符的 ZIP
 *
 * 不支持：
 * - ZIP64
 * - 加密 ZIP
 * - 其它压缩算法
 *
 * 仅用于可信的本地扩展包导入，不作为通用解压库。
 */

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const DEFAULT_LIMITS = {
  maxEntries: 500,
  maxEntrySize: 10 * 1024 * 1024,
  maxTotalSize: 50 * 1024 * 1024,
};

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset;
  }
  return -1;
}

function decodeName(buffer, flags) {
  const text = buffer.toString('utf8');
  // UTF-8 标志位未设置时也优先按 UTF-8 解码，失败则退回 Latin-1
  if (flags & 0x800) return text;
  if (text.includes('\uFFFD')) return buffer.toString('latin1');
  return text;
}

/**
 * 读取 ZIP 中的所有文件条目。
 * @param {Buffer} buffer ZIP 二进制
 * @param {{maxEntries?:number,maxEntrySize?:number,maxTotalSize?:number}} options
 * @returns {{name:string,size:number,data:Buffer}[]}
 */
export function readZipEntries(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('不是有效的 ZIP 文件');
  }

  const limits = { ...DEFAULT_LIMITS, ...options };
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error('未找到 ZIP 中央目录');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式，请使用普通 ZIP');
  }
  if (entryCount > limits.maxEntries) {
    throw new Error(`ZIP 条目过多（最多 ${limits.maxEntries} 个）`);
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('ZIP 中央目录越界，文件可能已损坏');
  }

  const entries = [];
  let totalSize = 0;
  let position = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL_SIG) {
      throw new Error('ZIP 中央目录结构损坏');
    }

    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);

    if (nameLength === 0 || position + 46 + nameLength > buffer.length) {
      throw new Error('ZIP 条目名称损坏');
    }
    const rawName = buffer.subarray(position + 46, position + 46 + nameLength);
    const name = decodeName(rawName, flags);
    position += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // 目录
    if (flags & 0x1) throw new Error(`不支持加密 ZIP 条目：${name}`);

    if (uncompressedSize > limits.maxEntrySize) {
      throw new Error(`ZIP 条目过大：${name}`);
    }
    totalSize += uncompressedSize;
    if (totalSize > limits.maxTotalSize) {
      throw new Error('ZIP 解压后总大小超出限制');
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP 本地文件头损坏：${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new Error(`ZIP 条目数据越界：${name}`);
    }

    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(compressed);
      } catch (error) {
        throw new Error(`ZIP 条目解压失败：${name}（${error.message}）`);
      }
    } else {
      throw new Error(`不支持的 ZIP 压缩算法（method ${method}）：${name}`);
    }

    if (data.length > limits.maxEntrySize) {
      throw new Error(`ZIP 条目解压后过大：${name}`);
    }

    entries.push({ name, size: data.length, data });
  }

  return entries;
}
