// Visszalépés kezelése mobilon: a megnyitott rétegek (lap, naptár, adatlap, fül) veremben,
// a böngésző „vissza” (iOS-en a képernyő bal széléről jobbra húzás) mindig a legfelsőt zárja be.
import { useEffect, useRef } from 'react';

const stack: { fn: () => void }[] = [];

function guard() {
  if (typeof history === 'undefined') return;
  if (!history.state?.cfBack) history.pushState({ cfBack: true }, '');
}

/** Visszalépés kezelő regisztrálása, amíg `active` igaz (a később megnyitott réteg kerül felülre). */
export function useBack(active: boolean, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const h = { fn: () => ref.current() };
    stack.push(h);
    guard();
    return () => {
      const i = stack.indexOf(h);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** A legfelső réteg bezárása; true, ha volt mit. */
export function goBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.fn();
  return true;
}

/** Egyszer, az alkalmazás gyökerében: böngésző-vissza + (telepített appnál) bal szélső húzás. */
export function installBackHandling() {
  const onPop = () => {
    if (goBack()) setTimeout(() => stack.length && guard(), 60);
  };
  window.addEventListener('popstate', onPop);
  // telepített (főképernyős) appban nincs natív húzás-vissza → saját gesztus
  const standalone = (navigator as any).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  let sx = -1,
    sy = 0;
  const ts = (e: TouchEvent) => {
    const t = e.touches[0];
    sx = t.clientX < 28 ? t.clientX : -1;
    sy = t.clientY;
  };
  const te = (e: TouchEvent) => {
    if (sx < 0) return;
    const t = e.changedTouches[0];
    if (t.clientX - sx > 70 && Math.abs(t.clientY - sy) < 60 && stack.length) history.back();
    sx = -1;
  };
  if (standalone) {
    window.addEventListener('touchstart', ts, { passive: true });
    window.addEventListener('touchend', te, { passive: true });
  }
  return () => {
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('touchstart', ts);
    window.removeEventListener('touchend', te);
  };
}
