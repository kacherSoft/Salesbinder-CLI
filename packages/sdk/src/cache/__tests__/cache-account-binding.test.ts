import { createSalesBinderAccountBinding } from '../types.js';

describe('createSalesBinderAccountBinding', () => {
  it('normalizes the configured SalesBinder subdomain into a stable identity', () => {
    expect(createSalesBinderAccountBinding(' Acme.SalesBinder.com. ')).toEqual({
      accountIdentity: 'salesbinder:acme',
      accountSubdomain: 'acme',
    });
  });

  it.each(['', 'https://acme.salesbinder.com', 'acme/path', '-acme', 'acme_1'])(
    'rejects unsafe identity input %p',
    (value) => {
      expect(() => createSalesBinderAccountBinding(value)).toThrow(/subdomain is invalid/i);
    },
  );
});
