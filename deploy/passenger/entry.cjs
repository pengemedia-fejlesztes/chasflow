// Passenger CommonJS-kent tolti be (PassengerStartupFile deploy/passenger/entry.cjs); innen indul az ESM belepesi pont.
import('../../src/server/runtime/entry.mjs').catch((e) => { console.error('inditasi hiba', e); process.exit(1); });
