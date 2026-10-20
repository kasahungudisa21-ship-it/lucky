import { PrismaClient } from "@prisma/client";

const ETB = 100;

type HouseSpec = {
  /** the name participants see */
  label: string;
  capacity: number;
  priceCents: number;
};

/**
 * Houses named by their seat count: 20 seats costs 20 birr a seat, up to 100.
 * 100A/100B/100C are three more houses of the same size and price, and the
 * higher stakes houses all hold 100 seats but charge their own price per seat.
 */
const HOUSES: HouseSpec[] = [
  ...[20, 30, 40, 50, 60, 70, 80, 90, 100].map((n) => ({ label: String(n), capacity: n, priceCents: n * ETB })),
  ...["100A", "100B", "100C"].map((label) => ({ label, capacity: 100, priceCents: 100 * ETB })),
  ...[200, 500, 1000, 2000, 5000].map((n) => ({ label: String(n), capacity: 100, priceCents: n * ETB })),
];

const prisma = new PrismaClient();

async function main() {
  for (const [i, spec] of HOUSES.entries()) {
    const house = await prisma.house.upsert({
      where: { label: spec.label },
      update: { ordinal: i + 1, capacity: spec.capacity, priceCents: spec.priceCents },
      create: { ...spec, ordinal: i + 1 },
    });

    const held = await prisma.seat.findMany({ where: { houseId: house.id }, select: { number: true } });
    const known = new Set(held.map((seat) => seat.number));
    const missing: number[] = [];
    for (let number = 1; number <= spec.capacity; number += 1) if (!known.has(number)) missing.push(number);
    if (missing.length) {
      await prisma.seat.createMany({
        data: missing.map((number) => ({ houseId: house.id, number, status: "open" })),
      });
    }
  }

  const houses = await prisma.house.count();
  const seats = await prisma.seat.count();
  console.log(`seeded ${houses} houses, ${seats} seats`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
