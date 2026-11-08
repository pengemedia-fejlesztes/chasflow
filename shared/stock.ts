// Raktárkészlet: raktárak, készletmozgások (bevételezés, kiadás, korrekció, átvezetés), és termékenként
// raktári mennyiség – lefoglalt mennyiség (partnerekhez rendelt, még nem teljesített) = elérhető mennyiség.
import type { PartnerProduct, Product } from './catalog';

export type MoveKind = 'bevet' | 'kiadas' | 'korrekcio' | 'atvezetes';
export const MOVE_LABEL: Record<MoveKind, string> = { bevet: 'Bevételezés', kiadas: 'Kiadás', korrekcio: 'Leltár / korrekció', atvezetes: 'Átvezetés' };

export interface Warehouse {
  id: string;
  name: string;
  note: string | null;
  archived: number;
}

export interface StockMove {
  id: string;
  product_id: string;
  warehouse_id: string;
  /** előjeles mennyiség (+ be, − ki) */
  qty: number;
  kind: MoveKind;
  /** átvezetésnél a pár mozgás közös azonosítója */
  ref: string | null;
  partner_key: string | null;
  note: string | null;
  created_by: number | null;
  created_at: number;
}

/** raktáranként összesített mennyiség */
export interface StockLevel {
  product_id: string;
  warehouse_id: string;
  qty: number;
}

export interface Inventory {
  onHand: number;
  reserved: number;
  available: number;
  byWarehouse: Record<string, number>;
  /** a foglalások: partner + mennyiség */
  reservations: PartnerProduct[];
  /** van-e készletnyilvántartása (mozgás vagy termék típus) */
  tracked: boolean;
}

/**
 * Lefoglalt: a partnerekhez rendelt mennyiség, ami még előttünk áll – egyszeri tételnél a folyó vagy későbbi
 * hónapra szóló, ismétlődőnél a még nem lezárt (záró hónap nélküli vagy a folyó hónapnál későbbi) hozzárendelés.
 */
export function isReservation(a: PartnerProduct, billing: string, cur: string): boolean {
  if (billing === 'egyszeri') return a.start_ym >= cur;
  return !a.end_ym || a.end_ym >= cur;
}

export function inventory(products: Product[], levels: StockLevel[], assigns: PartnerProduct[], cur: string): Map<string, Inventory> {
  const out = new Map<string, Inventory>();
  for (const p of products) out.set(p.id, { onHand: 0, reserved: 0, available: 0, byWarehouse: {}, reservations: [], tracked: p.kind === 'termek' });
  for (const l of levels) {
    const x = out.get(l.product_id);
    if (!x) continue;
    x.byWarehouse[l.warehouse_id] = (x.byWarehouse[l.warehouse_id] || 0) + l.qty;
    x.onHand += l.qty;
    x.tracked = true;
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const a of assigns) {
    const x = out.get(a.product_id);
    const p = byId.get(a.product_id);
    if (!x || !p || !isReservation(a, a.billing || p.billing, cur)) continue;
    x.reserved += a.qty;
    x.reservations.push(a);
  }
  for (const x of out.values()) {
    x.onHand = round(x.onHand);
    x.reserved = round(x.reserved);
    x.available = round(x.onHand - x.reserved);
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** CSV (pontosvesszős, Excel-barát, UTF-8 BOM) */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}
