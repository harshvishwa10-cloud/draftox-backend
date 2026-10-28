import { PrismaClient } from '@prisma/client';
import { closeCache, invalidateCatalog } from '../src/lib/cache.js';

const prisma = new PrismaClient();

interface SeedProduct {
  slug: string;
  name: string;
  description: string;
  price: number;
  mrp: number | null;
  image: string;
  features: string[];
  specifications: Record<string, string | number>;
  warrantyMonths: number;
  internalNotes?: string;
}

/**
 * Seeds the published DRAFTOX relay systems.
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
  // High-Voltage Series: standard relay channels plus extra heavy-load channels.
  // These are new catalog entries; the three standard systems above are unchanged.
  // mrp = declared M.R.P. supplied by the owner (displayed with strikethrough; savings are computed in the UI).
  {
    slug: 'draftox-16-channel-hv4',
    name: 'DRAFTOX 16-Channel + 4 High-Voltage Relay System',
    description:
      'ESP32-based 16-channel relay control with 4 additional high-voltage channels for heavy appliances such as geysers and air conditioners. Mobile app operation over Wi-Fi. Heavy-load channel setup and load suitability are confirmed with you before dispatch.',
    price: 9989,
    mrp: 11589,
    image: '/images/products/card-16-hv.png',
    warrantyMonths: 6,
    features: [
      '16 standard relay channels',
      '4 extra high-voltage channels for heavy appliances',
      'Mobile app operation over Wi-Fi',
      'Heavy-load setup confirmed before dispatch; installation by a licensed electrician',
    ],
    specifications: {
      platform: 'ESP32',
      channels: 16,
      highVoltageChannels: 4,
      totalChannels: 20,
      control: 'Mobile app over Wi-Fi',
      configuration: 'Confirmed before dispatch',
      series: 'high-voltage',
    },
    internalNotes:
      'High-voltage channels are driven through contactors. Load suitability and installation are confirmed with the customer before dispatch; mains wiring must be done by a licensed electrician. No electrical certifications or stock counts are claimed here.',
  },
  {
    slug: 'draftox-24-channel-hv7',
    name: 'DRAFTOX 24-Channel + 7 High-Voltage Relay System',
    description:
      'ESP32-based 24-channel relay control with 7 additional high-voltage channels for heavy appliances such as geysers and air conditioners. Mobile app operation over Wi-Fi. Heavy-load channel setup and load suitability are confirmed with you before dispatch.',
    price: 17989,
    mrp: 20789,
    image: '/images/products/card-24-hv.png',
    warrantyMonths: 12,
    features: [
      '24 standard relay channels',
      '7 extra high-voltage channels for heavy appliances',
      'Mobile app operation over Wi-Fi',
      'Heavy-load setup confirmed before dispatch; installation by a licensed electrician',
    ],
    specifications: {
      platform: 'ESP32',
      channels: 24,
      highVoltageChannels: 7,
      totalChannels: 31,
      control: 'Mobile app over Wi-Fi',
      configuration: 'Confirmed before dispatch',
      series: 'high-voltage',
    },
    internalNotes:
      'High-voltage channels are driven through contactors. Load suitability and installation are confirmed with the customer before dispatch; mains wiring must be done by a licensed electrician. No electrical certifications or stock counts are claimed here.',
  },
  {
    slug: 'draftox-40-channel-hv10',
    name: 'DRAFTOX 40-Channel + 10 High-Voltage Relay System',
    description:
      'ESP32-based 40-channel relay control with 10 additional high-voltage channels for heavy appliances such as geysers and air conditioners. Mobile app operation over Wi-Fi. Heavy-load channel setup and load suitability are confirmed with you before dispatch.',
    price: 26999,
    mrp: 28579,
    image: '/images/products/card-40-hv.png',
    warrantyMonths: 24,
    features: [
      '40 standard relay channels',
      '10 extra high-voltage channels for heavy appliances',
      'Mobile app operation over Wi-Fi',
      'Heavy-load setup confirmed before dispatch; installation by a licensed electrician',
    ],
    specifications: {
      platform: 'ESP32',
      channels: 40,
      highVoltageChannels: 10,
      totalChannels: 50,
      control: 'Mobile app over Wi-Fi',
      configuration: 'Confirmed before dispatch',
      series: 'high-voltage',
    },
    internalNotes:
      'High-voltage channels are driven through contactors. Load suitability and installation are confirmed with the customer before dispatch; mains wiring must be done by a licensed electrician. No electrical certifications or stock counts are claimed here.',
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
        ...(item.internalNotes ? { internalNotes: item.internalNotes } : {}),
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
          item.internalNotes ??
          'Owner-supplied catalog prices and warranty terms. Orders are confirmed (price, configuration, installation) before dispatch. No electrical certifications or stock counts are claimed here.',
      },
    });
    console.log(`Seeded product: ${product.slug} (status=${product.status}, price=${product.price})`);
  }

  try {
    await invalidateCatalog();
    console.log('Catalog cache invalidated');
  } catch {
    // A missing or unreachable Redis must never make the seed fail.
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeCache();
    await prisma.$disconnect();
  });
