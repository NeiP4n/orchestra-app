/**
 * The recovery mini-chat page (Б12). Plain HTML + vanilla JS, no framework,
 * no build step, no external resources: it must open even when the main app
 * bundle is broken or was never built. It talks to /api/recovery/* only.
 */
export const RECOVERY_PAGE_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orchestra — восстановление</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0 auto;max-width:720px;padding:24px 16px;color:#222;background:#fff}
h1{font-size:20px;margin:0 0 4px}
p{font-size:14px;line-height:1.5;color:#555}
label{font-size:13px;font-weight:600;display:block;margin:16px 0 4px}
select,textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid #ccc;border-radius:6px}
textarea{min-height:90px;resize:vertical}
button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #888;background:#222;color:#fff;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
button.ghost{background:#fff;color:#222}
#log{margin-top:16px;display:flex;flex-direction:column;gap:12px}
.msg{padding:10px 12px;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.5}
.msg.user{background:#eef2ff;align-self:flex-end;max-width:90%}
.msg.assistant{background:#f4f4f4;align-self:flex-start;max-width:100%}
.msg.error{background:#fdecea;color:#7a1f1f}
.steps{font-size:12px;color:#666;white-space:pre-wrap}
.fixed{border:1px solid #2e7d32;background:#e8f5e9;color:#1b5e20;padding:10px 12px;border-radius:8px;font-size:14px}
.meta{font-size:12px;color:#888}
#actions{margin-top:16px;display:none;gap:8px;flex-wrap:wrap}
#actions.show{display:flex}
code{background:#f0f0f0;padding:2px 6px;border-radius:4px}
</style>
</head>
<body>
<h1>Orchestra — восстановление</h1>
<p>Обычный вход в Orchestra не работает. Этот запасной чат чинит саму Orchestra: читает код и конфиг, правит файлы, запускает тесты. Работает автономно, без вопросов и разрешений.</p>
<label for="model">Модель</label>
<select id="model"><option value="">Загрузка моделей…</option></select>
<p id="model-error" class="meta"></p>
<label for="input">Что сломалось?</label>
<textarea id="input" placeholder="Опишите ошибку или оставьте текст ошибки ниже"></textarea>
<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
<button id="send">Отправить</button>
<button id="clear" class="ghost" type="button">Очистить чат</button>
</div>
<div id="log"></div>
<div id="actions">
<button id="open" type="button">Открыть Orchestra</button>
</div>
<p id="restart-hint" class="meta" style="display:none">Если агент менял код, перезапустите сервер: <code>orchestra service restart</code>, затем откройте Orchestra.</p>
<script>
(function(){
var modelSelect = document.getElementById('model');
var modelError = document.getElementById('model-error');
var input = document.getElementById('input');
var sendBtn = document.getElementById('send');
var clearBtn = document.getElementById('clear');
var log = document.getElementById('log');
var actions = document.getElementById('actions');
var restartHint = document.getElementById('restart-hint');
var openBtn = document.getElementById('open');
var messages = [];
function el(tag, cls, text){ var n = document.createElement(tag); if(cls) n.className = cls; if(text !== undefined) n.textContent = text; return n; }
function addMsg(role, text){
  var m = el('div', 'msg ' + (role === 'user' ? 'user' : role === 'error' ? 'error' : 'assistant'), text);
  log.appendChild(m);
  m.scrollIntoView({block:'nearest'});
  return m;
}
function showAuthNeeded(){
  addMsg('error', 'Нужно войти в Orchestra: откройте главную страницу и войдите, затем вернитесь сюда.');
}
function loadModels(){
  return fetch('/api/recovery/models', {credentials:'same-origin'})
    .then(function(res){
      if(res.status === 401){ showAuthNeeded(); throw new Error('unauthorized'); }
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data){
      var list = (data && data.data) || [];
      modelSelect.innerHTML = '';
      if(!list.length){
        modelSelect.innerHTML = '<option value="">Нет рабочих моделей</option>';
        modelError.textContent = 'Нет доступных рабочих моделей. Проверьте ключи провайдеров в настройках.';
        return;
      }
      list.forEach(function(m){
        var o = document.createElement('option');
        o.value = m.providerID + '/' + m.id;
        o.textContent = m.name + ' (' + m.providerID + ')';
        modelSelect.appendChild(o);
      });
      modelError.textContent = '';
    })
    .catch(function(err){
      if(err.message === 'unauthorized') return;
      modelSelect.innerHTML = '<option value="">Модели не загрузились</option>';
      modelError.textContent = 'Не удалось загрузить модели: ' + err.message;
    });
}
function send(){
  var text = input.value.trim();
  if(!text) return;
  var selected = modelSelect.value;
  if(!selected){ addMsg('error', 'Сначала выберите модель.'); return; }
  var slash = selected.indexOf('/');
  var model = { providerID: selected.slice(0, slash), id: selected.slice(slash + 1) };
  messages.push({ role: 'user', content: text });
  addMsg('user', text);
  input.value = '';
  sendBtn.disabled = true;
  var waiting = addMsg('assistant', 'Чиню… (модель читает код, правит файлы и запускает тесты)');
  fetch('/api/recovery/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: model, messages: messages })
  })
    .then(function(res){
      if(res.status === 401){ showAuthNeeded(); throw new Error('unauthorized'); }
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data){
      waiting.remove();
      messages.push({ role: 'assistant', content: data.reply });
      addMsg('assistant', data.reply);
      if(data.steps && data.steps.length){
        var steps = data.steps.map(function(s){
          return (s.success ? '✓ ' : '✗ ') + s.tool + ' — ' + s.output.slice(0, 300);
        }).join('\n');
        log.appendChild(el('div', 'steps', steps));
      }
      var meta = [];
      if(data.inputTokens || data.outputTokens) meta.push('Токены: ' + (data.inputTokens || 0) + ' in / ' + (data.outputTokens || 0) + ' out');
      if(meta.length) log.appendChild(el('div', 'meta', meta.join(' · ')));
      if(data.fixed){
        var fixed = el('div', 'fixed', 'Исправлено: ' + data.fixed);
        log.appendChild(fixed);
        actions.classList.add('show');
        restartHint.style.display = 'block';
      }
    })
    .catch(function(err){
      waiting.remove();
      if(err.message === 'unauthorized') return;
      addMsg('error', 'Ошибка: ' + err.message);
    })
    .finally(function(){ sendBtn.disabled = false; });
}
sendBtn.addEventListener('click', send);
input.addEventListener('keydown', function(e){
  if(e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
});
clearBtn.addEventListener('click', function(){ messages = []; log.innerHTML = ''; actions.classList.remove('show'); restartHint.style.display = 'none'; });
openBtn.addEventListener('click', function(){ location.href = '/'; });
if(location.hash.length > 1){
  try { input.value = decodeURIComponent(location.hash.slice(1)).slice(0, 2000); } catch (e) {}
}
loadModels();
})();
</script>
</body>
</html>
`
