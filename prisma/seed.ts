import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedProduct {
  slug: string;
  name: string;
  description: string;
  price: number;
  mrp: number;
  image: string;
  features: string[];
  specifications: Record<string, string | number>;
  warrantyMonths: number;
}

/**
 * Seeds the three published DRAFTOX relay systems.
 *
 * Prices, reference prices and warranty terms are the owner-supplied catalog
 * values — the backend is authoritative for them at checkout and the warranty
 * promise is snapshotted into each order item at purchase time. Availability
 * stays PREORDER: every order is confirmed (price, configuration, installation)
 * with the customer before dispatch, so nothing here claims shelf stock,
 * ratings, or certifications.
 */
const CATALOG: SeedProduct[] = [
  {
    slug: 'draftox-16-channel',
    name: 'DRAFTOX 16-Channel Relay System',
    description:
      'ESP32-based 16-channel relay control with mobile app operation. A compact option for smaller installations; channel setup is confirmed before dispatch.',
    price: 7999,
    mrp: 13500,
    image: '/images/products/card-16.png',
    warrantyMonths: 6,
    features: [
      '16 relay channels in one controller',
      'Mobile app operation over Wi-Fi',
      'Channel setup confirmed before dispatch',
    ],
    specifications: {
      platform: 'ESP32',
      channels: 16,
      control: 'Mobile app over Wi-Fi',
      configuration: 'Confirmed before dispatch',
    },
  },
  {
    slug: 'draftox-24-channel',
    name: 'DRAFTOX 24-Channel Relay System',
    description:
      'ESP32-based 24-channel relay control for larger homes and small sites. Greater channel capacity with mobile app operation; configuration confirmed before dispatch.',
    price: 11999,
    mrp: 16999,
    image: '/images/products/card-24.png',
    warrantyMonths: 12,
    features: [
      '24 relay channels in one system',
      'Mobile app operation over Wi-Fi',
      'Channel setup confirmed before dispatch',
    ],
    specifications: {
      platform: 'ESP32',
      channels: 24,
      control: 'Mobile app over Wi-Fi',
      configuration: 'Confirmed before dispatch',
    },
  },
  {
    slug: 'draftox-40-channel',
    name: 'DRAFTOX 40-Channel Relay System',
    description:
      'ESP32-based 40-channel relay control for extensive multi-room installations. Channel planning is worked out with the DRAFTOX team before dispatch.',
    price: 19999,
    mrp: 24000,
    image: '/images/products/card-40.png',
    warrantyMonths: 24,
    features: [
      '40 relay channels in one system',
      'Mobile app operation over Wi-Fi',
      'Channel plan worked out with the DRAFTOX team',
    ],
    specifications: {
      platform: 'ESP32',
      channels: 40,
      control: 'Mobile app over Wi-Fi',
      configuration: 'Planned with the DRAFTOX team',
    },
  },
];

async function main(): Promise<void> {
  for (const item of CATALOG) {
    const product = await prisma.product.upsert({
      where: { slug: item.slug },
      update: {
        name: item.name,
        description: item.description,
        status: 'PUBLISHED',
        price: item.price,
        mrp: item.mrp,
        currency: 'INR',
        image: item.image,
        availability: 'PREORDER',
        specifications: item.specifications,
        features: item.features,
        warrantyMonths: item.warrantyMonths,
      },
      create: {
        slug: item.slug,
        name: item.name,
        description: item.description,
        status: 'PUBLISHED',
        price: item.price,
        mrp: item.mrp,
        currency: 'INR',
        image: item.image,
        availability: 'PREORDER',
        specifications: item.specifications,
        features: item.features,
        warrantyMonths: item.warrantyMonths,
        internalNotes:
          'Owner-supplied catalog prices and warranty terms. Orders are confirmed (price, configuration, installation) before dispatch. No electrical certifications or stock counts are claimed here.',
      },
    });
    console.log(`Seeded product: ${product.slug} (status=${product.status}, price=${product.price})`);
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
