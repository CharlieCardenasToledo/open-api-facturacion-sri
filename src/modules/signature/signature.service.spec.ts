import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SignatureService } from './signature.service';

jest.mock('node-forge', () => ({
  util: {
    createBuffer: jest.fn(() => ({
      getBytes: () => 'binary-data',
    })),
  },
  asn1: {
    fromDer: jest.fn(() => 'asn1-mock'),
  },
  pkcs12: {
    pkcs12FromAsn1: jest.fn(() => ({
      safeContents: [
        {
          safeBags: [
            {
              type: '1.2.840.113549.1.12.10.1.1',
              key: 'fake-private-key',
            },
            {
              type: '1.2.840.113549.1.12.10.1.3',
              cert: {
                subject: {
                  getField: jest.fn((key: string) => {
                    const map: Record<string, string> = {
                      CN: 'Test CN',
                      O: 'Test Org',
                      C: 'EC',
                    };
                    return map[key] ? { value: map[key] } : null;
                  }),
                },
                issuer: {
                  getField: jest.fn((key: string) => {
                    const map: Record<string, string> = {
                      CN: 'Issuer CN',
                    };
                    return map[key] ? { value: map[key] } : null;
                  }),
                },
                validity: {
                  notBefore: new Date('2025-01-01'),
                  notAfter: new Date('2027-12-31'),
                },
                serialNumber: 'ABC123',
              },
            },
          ],
        },
      ],
    })),
  },
  pki: {
    oids: {
      pkcs8ShroudedKeyBag: '1.2.840.113549.1.12.10.1.1',
      certBag: '1.2.840.113549.1.12.10.1.3',
    },
  },
}));

jest.mock('../../common/utils/storage-paths', () => ({
  STORAGE_PATHS: {
    certs: '/fake/certs',
    pdfsConFirma: '/fake/pdfs/con-firma',
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(() => Buffer.from('fake-p12')),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('path', () => ({
  join: jest.fn((...args: string[]) => args.join('/')),
  resolve: jest.fn((...args: string[]) => args.join('/')),
  extname: jest.fn((f: string) => {
    const i = f.lastIndexOf('.');
    return i > 0 ? f.substring(i) : '';
  }),
  basename: jest.fn((f: string) => f),
  dirname: jest.fn((f: string) => f),
}));

import * as fs from 'fs';
import { BadRequestException } from '@nestjs/common';

describe('SignatureService', () => {
  let service: SignatureService;
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'signature') return { qrSize: 50, totalWidth: 200, defaultX: 0, defaultY: 0, defaultPage: -1 };
        return undefined;
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        SignatureService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(SignatureService);
  });

  describe('extractCertificateInfo', () => {
    it('should extract certificate info from P12 buffer', () => {
      const result = service.extractCertificateInfo(Buffer.from('fake-p12'), 'password');

      expect(result.subject.commonName).toBe('Test CN');
      expect(result.issuer.commonName).toBe('Issuer CN');
      expect(result.serialNumber).toBe('ABC123');
      expect(result.validity.notBefore).toBeDefined();
      expect(result.validity.notAfter).toBeDefined();
    });

    it('should throw error when private key or cert not found in P12', () => {
      const forge = require('node-forge');
      const original = forge.pkcs12.pkcs12FromAsn1;
      forge.pkcs12.pkcs12FromAsn1 = jest.fn(() => ({
        safeContents: [{ safeBags: [] }],
      }));

      expect(() =>
        service.extractCertificateInfo(Buffer.from('empty-p12'), 'pass'),
      ).toThrow('No se pudo extraer la clave privada o el certificado');

      forge.pkcs12.pkcs12FromAsn1 = original;
    });

    it('should prefer non-CA cert when multiple certs found', () => {
      const forge = require('node-forge');
      const original = forge.pkcs12.pkcs12FromAsn1;
      const makeCert = (cn: string, isCA: boolean) => ({
        subject: {
          getField: jest.fn((k: string) =>
            k === 'CN' ? { value: cn } : k === 'O' ? { value: 'Org' } : k === 'C' ? { value: 'EC' } : null,
          ),
        },
        issuer: {
          getField: jest.fn((k: string) =>
            k === 'CN' ? { value: 'Issuer' } : null,
          ),
        },
        validity: { notBefore: new Date('2025-01-01'), notAfter: new Date('2027-12-31') },
        serialNumber: cn,
        extensions: isCA ? [{ name: 'basicConstraints', cA: true }] : [],
      });

      forge.pkcs12.pkcs12FromAsn1 = jest.fn(() => ({
        safeContents: [{
          safeBags: [
            { type: '1.2.840.113549.1.12.10.1.1', key: 'fake-key' },
            { type: '1.2.840.113549.1.12.10.1.3', cert: makeCert('CA-Cert', true) },
            { type: '1.2.840.113549.1.12.10.1.3', cert: makeCert('Leaf-Cert', false) },
          ],
        }],
      }));

      const result = service.extractCertificateInfo(Buffer.from('multi-cert-p12'), 'pass');
      expect(result.subject.commonName).toBe('Leaf-Cert');

      forge.pkcs12.pkcs12FromAsn1 = original;
    });
  });

  describe('generateQR', () => {
    it('should generate QR code buffer', async () => {
      const result = await service.generateQR('https://test.com/verify');
      expect(result).toBeDefined();
      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });

  describe('signPDF', () => {
    it('should throw BadRequestException when certificate file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await expect(
        service.signPDF(Buffer.from('%PDF-1.4 test'), 'missing.p12', 'pass'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for path traversal in cert name', async () => {
      await expect(
        service.signPDF(Buffer.from('%PDF-1.4'), '../../../etc/passwd', 'pass'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for cert name with backslash', async () => {
      await expect(
        service.signPDF(Buffer.from('%PDF-1.4'), '..\\secret', 'pass'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for empty cert name', async () => {
      await expect(
        service.signPDF(Buffer.from('%PDF-1.4'), '', 'pass'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should attempt to sign PDF when certificate exists', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('fake-p12'));

      // The actual signing will fail because the PDF buffer is invalid
      // and the P12 is mocked, but we verify it gets past the cert check
      await expect(
        service.signPDF(Buffer.from('%PDF-1.4 test'), 'cert.p12', 'pass', {}),
      ).rejects.toThrow();
    });
  });

  describe('addVisualSignature', () => {
    it('should throw error for invalid PDF buffer', async () => {
      const qrBuffer = Buffer.from('qr-image');
      await expect(
        service.addVisualSignature(Buffer.from('invalid'), qrBuffer, 'Test Person', 'Test Org', 'Issuer CN', '2026-01-01', {}),
      ).rejects.toThrow();
    });
  });
});
