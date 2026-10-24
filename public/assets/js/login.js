const form = document.getElementById('loginForm');
const message = document.getElementById('loginMessage');
const button = form.querySelector('[type=submit]');
const visibility = document.getElementById('showPassword');
visibility.addEventListener('click', () => {
  const input = document.getElementById('password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  visibility.textContent = show ? 'Ocultar' : 'Mostrar';
  visibility.setAttribute('aria-pressed', String(show));
  visibility.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  button.disabled = true;
  button.textContent = 'Ingresando…';
  try {
    const response = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:form.username.value.trim(),password:form.password.value}) });
    const data = await response.json();
    if (!response.ok) {
      message.textContent = data.error === 'locked' ? `Cuenta bloqueada temporalmente. Intenta en ${Math.max(1,Math.ceil(data.waitSec/60))} minutos.` : data.error === 'bad-credentials' ? 'Usuario o contraseña incorrectos.' : 'No se pudo iniciar sesión. Intenta más tarde.';
      return;
    }
    location.assign('/panel.html#dashboard');
  } catch { message.textContent = 'No hay conexión con el servidor. Intenta nuevamente.'; }
  finally { button.disabled = false; button.innerHTML = 'Entrar al inventario <span aria-hidden="true">→</span>'; }
});
fetch('/me').then(response=>response.json()).then(data=>{if(data.user) location.replace('/panel.html#dashboard');}).catch(()=>{});
