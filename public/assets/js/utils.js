export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const number = value => new Intl.NumberFormat('es-PE').format(Number(value || 0));

export const dateOnly = (date = new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export const dateTime = () => { const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).reduce((o,p)=>({...o,[p.type]:p.value}),{}); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; };
export function formatDate(value) {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  const raw=String(value);
  const timestamp=/^\d{4}-\d{2}-\d{2} /.test(raw)?raw.replace(' ','T')+'Z':/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)?raw+'-05:00':raw;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? esc(value) : esc(parsed.toLocaleString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}));
}
