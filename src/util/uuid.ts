import { randomBytes } from 'crypto';

/**
 * UUIDv7 generator.
 *
 * Layout (RFC 9562):
 *   48 bits unix-millis | 4 bits version (0111) | 12 bits rand_a
 *   2 bits variant (10) | 62 bits rand_b
 */
export function uuidv7(): string {
    const ts = BigInt(Date.now());
    const rand = randomBytes(10);

    const bytes = Buffer.alloc(16);
    // 48 bits timestamp, big-endian
    bytes[0] = Number((ts >> 40n) & 0xffn);
    bytes[1] = Number((ts >> 32n) & 0xffn);
    bytes[2] = Number((ts >> 24n) & 0xffn);
    bytes[3] = Number((ts >> 16n) & 0xffn);
    bytes[4] = Number((ts >> 8n) & 0xffn);
    bytes[5] = Number(ts & 0xffn);

    // version + 12 bits of randomness
    bytes[6] = (rand[0] & 0x0f) | 0x70;
    bytes[7] = rand[1];

    // variant (10xxxxxx) + 62 bits of randomness
    bytes[8] = (rand[2] & 0x3f) | 0x80;
    bytes[9] = rand[3];
    bytes[10] = rand[4];
    bytes[11] = rand[5];
    bytes[12] = rand[6];
    bytes[13] = rand[7];
    bytes[14] = rand[8];
    bytes[15] = rand[9];

    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
