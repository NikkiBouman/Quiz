/* drag.js — slepen om te herordenen, voor muis én touch (pointer events).
 *
 * enableDragSort(list, { handle, onDrop })
 *   list   : container; de directe kinderen met [data-idx] zijn sleepbaar
 *   handle : CSS-selector van de sleep-greep binnen elk item (bv ".grip").
 *            Slepen start alleen vanaf de greep, zodat normaal scrollen blijft werken.
 *   onDrop : (orderArray) => void — krijgt de nieuwe volgorde als lijst van data-idx
 *            (de oorspronkelijke indexen, in de nieuwe volgorde) na een verplaatsing.
 *
 * De pagina's renderen na elke wijziging volledig opnieuw; deze helper verplaatst tijdens
 * het slepen alleen de DOM-node en geeft bij loslaten de nieuwe volgorde terug, waarna de
 * aanroeper zijn data herordent en opnieuw rendert.
 */
export function enableDragSort(list, { handle, onDrop } = {}){
  if(!list || list._dragWired) return;
  list._dragWired = true;
  let dragEl = null, pid = null;

  const items = () => Array.from(list.children).filter(el => el.hasAttribute && el.hasAttribute('data-idx'));

  function afterEl(y){
    let closest = null, closestOffset = -Infinity;
    for(const el of items()){
      if(el === dragEl) continue;
      const box = el.getBoundingClientRect();
      const offset = y - (box.top + box.height/2);
      if(offset < 0 && offset > closestOffset){ closestOffset = offset; closest = el; }
    }
    return closest;
  }

  function onDown(e){
    if(handle && !(e.target.closest && e.target.closest(handle))) return;
    const item = e.target.closest('[data-idx]');
    if(!item || item.parentElement !== list) return;
    e.preventDefault();
    dragEl = item; pid = e.pointerId;
    try{ dragEl.setPointerCapture(pid); }catch(_){}
    dragEl.classList.add('dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once:true });
    document.addEventListener('pointercancel', onUp, { once:true });
  }
  function onMove(e){
    if(!dragEl) return;
    const after = afterEl(e.clientY);
    if(after == null){ if(list.lastElementChild !== dragEl) list.appendChild(dragEl); }
    else if(after !== dragEl){ list.insertBefore(dragEl, after); }
  }
  function onUp(){
    if(!dragEl) return;
    document.removeEventListener('pointermove', onMove);
    dragEl.classList.remove('dragging');
    const order = items().map(el => +el.dataset.idx);
    const moved = order.some((v,i) => v !== i);
    dragEl = null; pid = null;
    if(moved && onDrop) onDrop(order);
  }

  list.addEventListener('pointerdown', onDown);
}
