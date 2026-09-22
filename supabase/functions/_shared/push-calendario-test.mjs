// ═══════════════════════════════════════════════════════════════════════════
//  push-calendario-test — que el calendario NO caduque nunca más
//  ───────────────────────────────────────────────────────────────────────────
//  Dos tablas estaban escritas a mano y vencían: los feriados de NYSE (hasta 2027)
//  y las reuniones del FOMC (hasta 2026). La primera se calcula; la segunda la
//  sincroniza `fomc-sync` desde el calendario de la propia Fed.
//
//  Este arnés comprueba las dos mitades:
//    1 · el cálculo de feriados reproduce EXACTAMENTE las listas que estaban
//        escritas a mano para 2026 y 2027, y sigue dando diez días al año
//        coherentes hasta 2040
//    2 · el motor produce eventos de FOMC en cualquier año para el que haya
//        fechas, y sigue en pie cuando no las hay
//
//  Correr:  TZ=America/New_York node supabase/functions/_shared/push-calendario-test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import { feriadosNYSE, macroEventsForDay, FOMC_2026, iso, fromISO } from './push-rank.js';

let ok = 0, fallos = 0;
const test = (nombre, fn) => {
  try { fn(); ok++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fallos++; console.log(`  ✗ ${nombre}\n      ${e.message}`); }
};
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || ''}\n      esperado ${B}\n      obtenido ${A}`);
};

// Las dos listas literales que vivían en push-common.ts antes del 2026-09-22.
const VIEJA_2026 = ['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
  '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'];
const VIEJA_2027 = ['2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31',
  '2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24'];

console.log('\n── Feriados de NYSE, calculados ──');
test('2026 idéntico a la tabla que estaba escrita a mano', () => eq(feriadosNYSE(2026), VIEJA_2026));
test('2027 idéntico a la tabla que estaba escrita a mano', () => eq(feriadosNYSE(2027), VIEJA_2027));

test('2028–2040: diez feriados al año (nueve si Año Nuevo cae sábado), en día hábil', () => {
  for (let a = 2028; a <= 2040; a++) {
    const f = feriadosNYSE(a);
    const sabado = fromISO(`${a}-01-01`).getUTCDay() === 6;
    const esperados = sabado ? 9 : 10;
    if (f.length !== esperados) throw new Error(`${a}: ${f.length} feriados, no ${esperados} — ${f}`);
    for (const d of f) {
      const dow = fromISO(d).getUTCDay();
      if (dow === 0 || dow === 6) throw new Error(`${a}: ${d} cae en fin de semana`);
      if (d.slice(0, 4) !== String(a)) throw new Error(`${a}: ${d} no es de ese año`);
    }
    if (new Set(f).size !== f.length) throw new Error(`${a}: feriados repetidos`);
  }
});

// El 4 de julio y Navidad son los que ejercitan la regla de observancia; Año Nuevo
// es la excepción (NYSE no cierra el viernes anterior cuando el 1 cae sábado).
test('observancia: sábado → viernes, domingo → lunes', () => {
  eq(feriadosNYSE(2026)[6], '2026-07-03', '4 de julio de 2026 cae sábado');
  eq(feriadosNYSE(2027)[6], '2027-07-05', '4 de julio de 2027 cae domingo');
  eq(feriadosNYSE(2027)[9], '2027-12-24', 'Navidad de 2027 cae sábado');
});
test('Año Nuevo en sábado: ni el viernes previo ni el sábado entran', () => {
  // 2028-01-01 cae sábado. NYSE opera el viernes 31 de diciembre de 2027 y ese
  // año se queda con nueve cierres, no diez.
  if (fromISO('2028-01-01').getUTCDay() !== 6) throw new Error('premisa mala: no es sábado');
  const f = feriadosNYSE(2028);
  if (f.includes('2027-12-31')) throw new Error('se coló el 31 de diciembre');
  if (f.includes('2028-01-01')) throw new Error('se coló el sábado 1 de enero');
  eq(f.length, 9);
  eq(f[0], '2028-01-17', 'el primer cierre del año pasa a ser MLK');
});
test('Viernes Santo: 2026-04-03, 2027-03-26, 2030-04-19', () => {
  eq(feriadosNYSE(2026)[3], '2026-04-03');
  eq(feriadosNYSE(2027)[3], '2027-03-26');
  eq(feriadosNYSE(2030)[3], '2030-04-19');
});

console.log('\n── FOMC ──');
test('la lista de respaldo sigue produciendo los 8 eventos de 2026', () => {
  const dec = FOMC_2026.map((x) => x.decision);
  for (const f of dec) {
    const ev = macroEventsForDay(f).filter((e) => e.key === 'FOMC');
    if (ev.length !== 1) throw new Error(`${f}: ${ev.length} eventos FOMC`);
  }
});
test('con fechas de otro año, el motor las usa (no hay 2027 cableado)', () => {
  const futuro = [{ decision: '2031-03-19', minutes: '2031-04-09' }];
  if (macroEventsForDay('2031-03-19').some((e) => e.key === 'FOMC'))
    throw new Error('sin datos no debería haber FOMC en 2031');
  const con = macroEventsForDay('2031-03-19', futuro).filter((e) => e.key === 'FOMC');
  eq(con.length, 1, 'con datos sí debe haberlo');
  eq(macroEventsForDay('2031-04-09', futuro).filter((e) => e.key === 'FOMC_MIN').length, 1);
});
test('un año sin FOMC no rompe el calendario: siguen los demás eventos', () => {
  // El jueves siempre trae jobless claims, haya o no reuniones cargadas.
  const jueves = '2031-03-20';
  if (fromISO(jueves).getUTCDay() !== 4) throw new Error('premisa mala: no es jueves');
  if (!macroEventsForDay(jueves).some((e) => e.key === 'CLAIMS'))
    throw new Error('el calendario se quedó vacío sin FOMC');
});

console.log(fallos === 0 ? `\n✓ ${ok} pasan, 0 fallan` : `\n✗ ${ok} pasan, ${fallos} fallan`);
process.exit(fallos === 0 ? 0 : 1);
