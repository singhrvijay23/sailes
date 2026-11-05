import { describe, expect, it } from 'vitest';
import { normalizeShop, seal, signSessionToken, unseal, verifySessionToken, verifyWebhookHmac } from '../src/crypto.js';
import { htmlToText, toSailesOrder, toSailesProduct } from '../src/mapping.js';
import { config, product, signWebhook } from './fakes.js';

describe('crypto', () => {
  it('seals and unseals secrets, and detects tampering', () => {
    const s = seal('sk_live_123', config.encryptionKey);
    expect(s).not.toContain('sk_live');
    expect(unseal(s, config.encryptionKey)).toBe('sk_live_123');
    const parts = s.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => unseal(parts.join('.'), config.encryptionKey)).toThrow();
  });

  it('verifies App Bridge session tokens', () => {
    const t = signSessionToken('acme.myshopify.com', 'key', 'secret');
    expect(verifySessionToken(t, 'key', 'secret').shop).toBe('acme.myshopify.com');
    expect(() => verifySessionToken(t, 'other-key', 'secret')).toThrow(/audience/);
    expect(() => verifySessionToken(t, 'key', 'wrong-secret')).toThrow(/signature/);
    expect(() => verifySessionToken(signSessionToken('acme.myshopify.com', 'key', 'secret', -60), 'key', 'secret')).toThrow(/expired/);
    expect(() => verifySessionToken('a.b', 'key', 'secret')).toThrow();
  });

  it('verifies webhook signatures on the raw body', () => {
    const body = '{"id":1}';
    expect(verifyWebhookHmac(Buffer.from(body), signWebhook(body), config.apiSecret)).toBe(true);
    expect(verifyWebhookHmac(Buffer.from('{"id":2}'), signWebhook(body), config.apiSecret)).toBe(false);
    expect(verifyWebhookHmac(Buffer.from(body), undefined, config.apiSecret)).toBe(false);
  });

  it('accepts only myshopify.com shop domains', () => {
    expect(normalizeShop('https://Acme.myshopify.com/admin')).toBe('acme.myshopify.com');
    expect(normalizeShop('evil.com')).toBeNull();
    expect(normalizeShop('acme.myshopify.com.evil.com')).toBeNull();
    expect(normalizeShop(undefined)).toBeNull();
  });
});

describe('product mapping', () => {
  it('maps a single-variant product with one-click add to cart', () => {
    const p = toSailesProduct(product(7), 'USD')!;
    expect(p).toMatchObject({
      id: '7',
      title: 'Product 7',
      price: 12,
      compare_at_price: 15,
      currency: 'USD',
      in_stock: true,
      stock_qty: 5,
      brand: 'Acme',
      categories: ['Drinkware', 'Mugs', 'Kitchen'],
      attributes: {},
      image_url: 'https://cdn.shopify.com/p7.jpg',
      url: 'https://acme.example/products/product-7',
      add_to_cart_url: 'https://acme.example/cart/add?id=70&quantity=1',
    });
  });

  it('uses the lowest in-stock variant price and lists options for variable products', () => {
    const v = (id: string, price: string, available: boolean, size: string, color: string) => ({
      legacyResourceId: id,
      title: `${size} / ${color}`,
      price,
      compareAtPrice: null,
      availableForSale: available,
      inventoryQuantity: available ? 3 : 0,
      selectedOptions: [
        { name: 'Size', value: size },
        { name: 'Color', value: color },
      ],
    });
    const p = toSailesProduct(product(8, { variants: { nodes: [v('1', '9.00', false, 'S', 'Blue'), v('2', '20.00', true, 'M', 'Blue'), v('3', '25.00', true, 'L', 'Red')] } }), 'CAD')!;
    expect(p.price).toBe(20);
    expect(p.compare_at_price).toBeUndefined();
    expect(p.attributes).toEqual({ size: 'S, M, L', color: 'Blue, Red' });
    expect(p.variants[0]).toEqual({ id: '1', title: 'S / Blue', price: 9, in_stock: false, attributes: { size: 'S', color: 'Blue' } });
    expect(p.add_to_cart_url).toBeUndefined();
    expect(p.currency).toBe('CAD');
  });

  it('marks sold-out products out of stock and skips drafts and unpublished products', () => {
    const sold = product(9, { variants: { nodes: [{ ...product(9).variants.nodes[0]!, availableForSale: false }] } });
    expect(toSailesProduct(sold, 'USD')).toMatchObject({ in_stock: false });
    expect(toSailesProduct(sold, 'USD')!.add_to_cart_url).toBeUndefined();
    expect(toSailesProduct(product(10, { status: 'DRAFT' }), 'USD')).toBeNull();
    expect(toSailesProduct(product(11, { onlineStoreUrl: null }), 'USD')).toBeNull();
  });
});

describe('policies and orders', () => {
  it('turns policy HTML into short plain text', () => {
    expect(htmlToText('<h2>Shipping</h2><p>Free over $50 &amp; fast.</p><ul><li>US</li><li>Canada</li></ul><script>x()</script>')).toBe('Shipping\nFree over $50 & fast.\n- US\n- Canada');
    expect(htmlToText(`<p>${'a'.repeat(5000)}</p>`)).toHaveLength(4000);
  });

  it('finds the SAILES conversation on the order', () => {
    const conv = '0b9a4f6e-3a2c-4d5e-9f10-1234567890ab';
    expect(toSailesOrder({ id: 555, current_total_price: '64.00', note_attributes: [{ name: '_sailes_conversation', value: conv }], line_items: [{ product_id: 1 }, { product_id: 1 }, { product_id: null }] })).toEqual({
      orderId: '555',
      total: 64,
      conversationId: conv,
      productIds: ['1'],
    });
    expect(toSailesOrder({ id: 556, total_price: '10.00', line_items: [{ product_id: 2, properties: [{ name: '_sailes_conversation', value: conv }] }] }).conversationId).toBe(conv);
    expect(toSailesOrder({ id: 557, total_price: '10.00', note_attributes: [{ name: '_sailes_conversation', value: 'junk' }] }).conversationId).toBeNull();
  });
});
