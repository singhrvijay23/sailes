import { createHash } from 'node:crypto';
import { EMBEDDING_DIMS } from './types.js';

/**
 * Local, free "embedding" based on feature hashing of words, word pairs and character
 * trigrams. It is not semantic like a neural model, but it gives typo-tolerant fuzzy
 * matching in the vector leg of hybrid search. Used in demo mode, in tests and for
 * Claude tenants (Anthropic offers no embeddings endpoint).
 */
export const HASH_EMBED_MODEL = 'sailes-hash-v1';

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'is', 'it', 'this', 'that', 'my', 'i', 'me', 'you', 'your', 'our', 'we', 'be', 'are', 'at', 'by', 'from', 'as']);

export function tokenize(text: string, stemWords = true): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (stemWords ? stem(t) : t));
}

/** Tiny suffix stripper so "shoes"/"shoe" and "running"/"run" land in the same bucket. */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) {
    const r = t.slice(0, -3);
    // running -> run, shopping -> shop
    return /([b-df-hj-np-tv-z])\1$/.test(r) && !/(ll|ss|zz)$/.test(r) ? r.slice(0, -1) : r;
  }
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('es') && /(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function bucket(feature: string): [number, number] {
  const h = createHash('md5').update(feature).digest();
  return [h.readUInt32LE(0) % EMBEDDING_DIMS, h[4]! & 1 ? 1 : -1];
}

export function hashEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  const toks = tokenize(text);
  const add = (f: string, w: number) => {
    const [i, sign] = bucket(f);
    v[i]! += sign * w;
  };
  toks.forEach((t, i) => {
    add('w:' + t, 1.0);
    if (i > 0) add('b:' + toks[i - 1] + '_' + t, 0.5);
    const padded = `#${t}#`;
    for (let j = 0; j + 3 <= padded.length; j++) add('c:' + padded.slice(j, j + 3), 0.25);
  });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
