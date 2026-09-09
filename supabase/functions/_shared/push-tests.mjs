// Casos borde de las dos notificaciones + reglas de copy.
//   TZ=America/New_York node supabase/functions/_shared/push-tests.mjs
import {
  textoCierre, textoMatutino, pvNewsRank, macroEventsForDay, eventoDeResultados,
  violacionesDeCopy, listaTickers, umbralPara, exposicionEfectiva, pesosDeCartera,
} from './push-rank.js';

let ok = 0, fail = 0;
const t = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log('  ✓', nombre); }
  else { fail++; console.log('  ✗', nombre, extra); }
};
const h = (ticker, w, dayChgPct) => ({ ticker, qty: w * 1000, price: 100, dayChgPct });

console.log('\n── Fase 3 · notificación de cierre ──');
{
  const r = textoCierre([h('NVDA',.5,4.1), h('META',.5,-0.3)]);
  t('todo sube: incluye líder y el más flojo', /lideró/.test(r.cuerpo) && /floja/.test(r.cuerpo), r?.cuerpo);
}
{
  const r = textoCierre([h('NVDA',.5,-4.2), h('AAPL',.5,-0.2)]);
  t('todo baja: incluye la mayor caída y quien resistió', /mayor caída/.test(r.cuerpo) && /resistió/.test(r.cuerpo), r?.cuerpo);
}
{
  const r = textoCierre([h('NVDA',.5,1.9), h('AAPL',.5,-1.82)]);
  t('movimiento < 0.1%: lo llama "casi sin cambio"', /casi sin cambio/.test(r.cuerpo), r?.cuerpo);
}
{
  const r = textoCierre([h('NVDA',1,-2.1)]);
  t('una sola posición: lo dice explícitamente', /única posición/.test(r.cuerpo), r?.cuerpo);
}
t('sin posiciones → NO enviar', textoCierre([]) === null);
t('posiciones sin dato del día → NO enviar', textoCierre([{ticker:'NVDA',qty:1,price:100}]) === null);
{
  const r = textoCierre([h('NVDA',.5,-2.1), h('AAPL',.5,1.4)]);
  t('día rojo: SIEMPRE aparece también el ganador', /AAPL/.test(r.cuerpo) && /subió/.test(r.cuerpo), r?.cuerpo);
  t('nunca dólares, sólo porcentajes', !/\$/.test(r.cuerpo), r?.cuerpo);
  t('deep link apunta a la posición, no al home', r.ticker === 'NVDA');
}

console.log('\n── Fase 2 · casos borde del motor matutino ──');
const cartera = [h('NVDA',.30,0), h('AAPL',.20,0), h('MSFT',.20,0), h('VOO',.30,0)];
{
  const r = pvNewsRank({ fechaISO:'2026-09-12', eventos: [], holdings: cartera, historial: [] });
  t('ningún evento hoy → NO enviar', !r.enviado && r.motivo === 'sin_eventos_elegibles');
}
{
  const bajo = macroEventsForDay('2026-09-11').map(e => ({ ...e, imp:'low' }));
  const r = pvNewsRank({ fechaISO:'2026-09-11', eventos: bajo, holdings: [h('KO',1,0)], historial: [] });
  t('sólo impacto bajo y sin exposición → NO enviar', !r.enviado, r.motivo);
}
{
  // Alto impacto que NO toca su cartera: se envía, pero SIN línea de exposición.
  const ev = macroEventsForDay('2026-09-04');                       // NFP
  const soloKO = [h('KO',1,0)];
  const r = pvNewsRank({ fechaISO:'2026-09-04', eventos: ev, holdings: soloKO, historial: [] });
  const txt = r.enviado ? textoMatutino(r.ganador, soloKO) : null;
  t('alto impacto sin tocar su cartera → se envía sin exposición',
    r.enviado && !/Toca \d/.test(txt.cuerpo), txt && txt.cuerpo);
}
{
  const ev = macroEventsForDay('2026-09-04');
  const hist = [{ fecha:'2026-09-01', enviado:true, ganador_id: ev[0].id, ganador_tickers:[], ganador_tipo:'x', ganador_pista:'A' }];
  const r = pvNewsRank({ fechaISO:'2026-09-04', eventos: ev, holdings: cartera, historial: hist });
  t('anti-duplicado 7 días: no repite el mismo evento_id',
    !r.candidatos.some(c => c.id === ev[0].id));
}
{
  const ev = macroEventsForDay('2026-09-09');
  const a = JSON.stringify(pvNewsRank({ fechaISO:'2026-09-09', eventos: ev, holdings: cartera, historial: [] }));
  const b = JSON.stringify(pvNewsRank({ fechaISO:'2026-09-09', eventos: ev.slice().reverse(), holdings: cartera, historial: [] }));
  t('determinista incluso con los eventos en otro orden', a === b);
}

console.log('\n── Descuento de ETF amplio ──');
{
  const { pesos } = pesosDeCartera([h('VOO',1,0)]);
  t('VOO (amplio) al 100% → E = 30, no 100', exposicionEfectiva(['VOO'], pesos) === 30);
  const { pesos: p2 } = pesosDeCartera([h('XLF',1,0)]);
  t('XLF (sectorial) al 100% → E = 100, sin descuento', exposicionEfectiva(['XLF'], p2) === 100);
}

console.log('\n── Umbral adaptativo ──');
{
  const cinco = (abierto) => Array.from({length:5}, (_,i) => ({ fecha:`2026-09-0${i+1}`, enviado:true, abierto }));
  t('sin abrir 5 seguidas → umbral 65', umbralPara(cinco(false)) === 65);
  t('si abre → vuelve a 45', umbralPara(cinco(true)) === 45);
  t('con menos de 5 enviadas → 45', umbralPara([{fecha:'2026-09-01',enviado:true,abierto:false}]) === 45);
}

console.log('\n── Reglas de copy ──');
{
  t('máximo 3 tickers, luego "y N más"', listaTickers(['A','B','C','D','E','F','G']) === 'A, B, C y 4 más');
  t('3 tickers se listan enteros', listaTickers(['AAPL','AMZN','MA']) === 'AAPL, AMZN y MA');
  // Todos los textos posibles del calendario + del cierre, contra la lista prohibida.
  let sucios = [];
  for (const d of ['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-16','2026-08-19','2026-08-28']) {
    for (const ev of macroEventsForDay(d)) sucios.push(...violacionesDeCopy(ev.titulo + ' ' + ev.push_linea));
  }
  const cierres = [textoCierre([h('NVDA',.5,4.1),h('META',.5,-0.3)]),
                   textoCierre([h('NVDA',.5,-4.2),h('AAPL',.5,-0.2)]),
                   textoCierre([h('NVDA',1,-2.1)])];
  for (const c of cierres) sucios.push(...violacionesDeCopy(c.titulo + ' ' + c.cuerpo));
  sucios.push(...violacionesDeCopy(eventoDeResultados({ticker:'NVDA',fechaISO:'2026-09-09',cuando:'amc'}).push_linea));
  t('ningún imperativo ni emoji en ningún texto', sucios.length === 0, sucios.join(','));

  // Límites de la pantalla de bloqueo.
  let largos = [];
  for (const d of ['2026-09-01','2026-09-04','2026-09-16','2026-08-28']) {
    for (const ev of macroEventsForDay(d)) {
      const { titulo, cuerpo } = textoMatutino({ evento: ev, pista:'A' }, cartera);
      if (titulo.length > 35) largos.push(`título ${titulo.length}: ${titulo}`);
      if (cuerpo.length > 110) largos.push(`cuerpo ${cuerpo.length}: ${cuerpo}`);
    }
  }
  t('título ≤ 35 y cuerpo ≤ 110 caracteres', largos.length === 0, '\n     ' + largos.join('\n     '));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${ok} pasan, ${fail} fallan`);
process.exit(fail ? 1 : 0);
