/**
 * Guarded helper for the TEMPORARY ₹10 live Razorpay test.
 *
 * Changes ONE product row (slug `draftox-16-channel`) between its catalogue
 * price (₹7,999) and the test price (₹10). Nothing else is touched: no other
 * product, no mrp, no Razorpay/credential configuration.
 *
 * Usage (run from the backend repo, with the production environment file):
 *
 *   $env:ENV_FILE = ".env.production"
 *   npx tsx scripts/live-test-price.ts status
 *   npx tsx scripts/live-test-price.ts apply --confirm
 *   npx tsx scripts/live-test-price.ts revert --confirm
 *
 * `apply` refuses unless the current price is exactly 7999. `revert` refuses
 * unless it is exactly 10, so a stale or repeated run cannot overwrite an
 * unexpected value. Without `--confirm` the script only reports what it WOULD
 * do. The connection string (and its password) is never printed.
 */
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';

const ENV_FILE = process.env.ENV_FILE ?? '.env.production';
config({ path: ENV_FILE, override: true });

const SLUG = 'draftox-16-channel';
const CATALOGUE_PRICE = 7999;
const TEST_PRICE = 10;
const EXPECTED_MRP = 13500;
const EXPECTED_ID = 'cmvs9m4pe0000sluwztt0mvw4';

const prisma = new PrismaClient();

function usage(): never {
  console.error(
    'Usage: tsx scripts/live-test-price.ts <status|apply|revert> [--confirm]',
  );
  process.exit(2);
}

function connectionSummary(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return 'DATABASE_URL is not set';
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname} (password hidden)`;
  } catch {
    return 'DATABASE_URL is set (unparseable; password hidden)';
  }
}

async function load() {
  const product = await prisma.product.findUnique({
    where: { slug: SLUG },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      price: true,
      mrp: true,
      currency: true,
      updatedAt: true,
    },
  });
  if (!product) {
    throw new Error(`Product not found for slug ${SLUG}`);
  }
  return product;
}

type Product = Awaited<ReturnType<typeof load>>;

function describe(product: Product): string {
  return [
    `  id:        ${product.id}`,
    `  slug:      ${product.slug}`,
    `  name:      ${product.name}`,
    `  status:    ${product.status}`,
    `  price:     ${product.price?.toString() ?? 'null'}`,
    `  mrp:       ${product.mrp?.toString() ?? 'null'}`,
    `  currency:  ${product.currency}`,
    `  updatedAt: ${product.updatedAt.toISOString()}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const [, , action = 'status', ...flags] = process.argv;
  const confirm = flags.includes('--confirm');

  console.log(`Env file: ${ENV_FILE}`);
  console.log(`Database: ${connectionSummary()}`);

  const product = await load();

  if (product.id !== EXPECTED_ID) {
    throw new Error(
      `Refusing: expected product id ${EXPECTED_ID} for ${SLUG}, found ${product.id}`,
    );
  }
  if (Number(product.mrp) !== EXPECTED_MRP) {
    throw new Error(
      `Refusing: expected mrp ${EXPECTED_MRP} for ${SLUG}, found ${product.mrp?.toString()}`,
    );
  }

  const current = Number(product.price);

  if (action === 'status') {
    console.log(describe(product));
    return;
  }

  if (action === 'apply') {
    if (current === TEST_PRICE) {
      console.log(`Already at the test price ₹${TEST_PRICE}. Nothing to do.`);
      console.log(describe(product));
      return;
    }
    if (current !== CATALOGUE_PRICE) {
      throw new Error(
        `Refusing: expected current price ${CATALOGUE_PRICE}, found ${current}.`,
      );
    }
    if (!confirm) {
      console.log(
        `DRY RUN: would change ${SLUG} from ₹${CATALOGUE_PRICE} to ₹${TEST_PRICE}. ` +
          'Re-run with --confirm to apply.',
      );
      return;
    }
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { price: TEST_PRICE },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        price: true,
        mrp: true,
        currency: true,
        updatedAt: true,
      },
    });
    console.log(`Applied test price ₹${TEST_PRICE}.`);
    console.log(describe(updated));
    console.log('Allow up to 60 seconds for the catalogue cache to expire.');
    return;
  }

  if (action === 'revert') {
    if (current === CATALOGUE_PRICE) {
      console.log(`Already at the catalogue price ₹${CATALOGUE_PRICE}. Nothing to do.`);
      console.log(describe(product));
      return;
    }
    if (current !== TEST_PRICE) {
      throw new Error(`Refusing: expected current price ${TEST_PRICE}, found ${current}.`);
    }
    if (!confirm) {
      console.log(
        `DRY RUN: would restore ${SLUG} from ₹${TEST_PRICE} to ₹${CATALOGUE_PRICE}. ` +
          'Re-run with --confirm to revert.',
      );
      return;
    }
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { price: CATALOGUE_PRICE },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        price: true,
        mrp: true,
        currency: true,
        updatedAt: true,
      },
    });
    console.log(`Restored catalogue price ₹${CATALOGUE_PRICE}.`);
    console.log(describe(updated));
    console.log('Allow up to 60 seconds for the catalogue cache to expire.');
    return;
  }

  usage();
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
