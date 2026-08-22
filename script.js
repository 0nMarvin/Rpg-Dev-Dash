const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const TABS_STORAGE_KEY = 'rpg_abas';
let abas = [];
let abaAtiva = null;

const DiceParser = {
    rolarDado(lados) { return Math.floor(Math.random() * lados) + 1; },
    rolar(notation) {
        const original = notation.trim().toLowerCase().replace(/\s+/g, '');
        const tokens = original.match(/[+\-]?[^+\-]+/g) || [];
        let total = 0; const partes = [];
        for (let token of tokens) {
            const sinal = token[0] === '-' ? -1 : 1;
            const parte = token.replace(/^[+\-]/, '');
            if (/^\d+d\d+(x\d+)?$/i.test(parte)) {
                const [dadoParte, multParte] = parte.split('x');
                const [qs, ls] = dadoParte.split('d');
                const qtd = parseInt(qs) || 1, lados = parseInt(ls) || 6;
                const multiplicador = multParte ? parseInt(multParte) : 1;
                let subTotal = 0; let rolls = [];
                for(let i = 0; i < qtd; i++) { let r = this.rolarDado(lados); rolls.push(r); subTotal += r; }
                const valorCalculado = subTotal * multiplicador;
                total += sinal * valorCalculado;
                partes.push(`${sinal < 0 ? '-' : partes.length ? '+' : ''}${qtd}d${lados}[${rolls.join(',')}]${multiplicador > 1 ? ` x${multiplicador}` : ''}`);
            } else if (/^\d+$/.test(parte)) {
                const num = sinal * parseInt(parte);
                total += num;
                partes.push((num >= 0 && partes.length ? '+' : '') + num);
            }
        }
        return { total, output: `${notation}: ${partes.join(' ')} = ${total}` };
    }
};

function renderMsg(data, container) {
    if (document.getElementById(`msg-${data.id}`)) return;
    const div = document.createElement('div');
    div.id = `msg-${data.id}`;
    div.className = data.resultado > 0 ? 'msg-box roll-accent' : 'msg-box';
    const hora = data.created_at ? new Date(data.created_at).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : '';
    div.innerHTML = `<div class="msg-header"><b>${data.usuario}</b> <small>${hora}</small></div>
        ${data.resultado > 0 ? `🎲 <b>${data.resultado}</b><br><small>${data.detalhe}</small>` : `<p>${data.texto}</p>`}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

async function carregarAbas() {
    const saved = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY));
    if (saved && saved.abas && saved.abas.length > 0) {
        abas = saved.abas; abaAtiva = saved.abaAtiva;
    } else {
        try {
            const res = await fetch('abas.json');
            if (res.ok) { abas = await res.json(); }
            else { console.error('Não foi possível carregar abas.json:', res.status); abas = []; }
        } catch (e) {
            console.error('Não foi possível carregar abas.json:', e);
            abas = [];
        }
        abaAtiva = abas[0]?.id;
        salvarAbas();
    }
}

// Lógica de aba única (um só iframe #main-frame, reaproveitado por todas as
// abas trocando o src). É mais simples que ter um iframe por aba e é a
// versão que comprovadamente carrega o tldraw sem bloqueios.
function renderAbas() {
    const list = document.getElementById('tab-list');
    const container = document.getElementById('sheet-container');
    const frame = document.getElementById('main-frame');
    list.innerHTML = '';

    abas.forEach(aba => {
        const div = document.createElement('div');
        div.className = `tab ${aba.id === abaAtiva ? 'active' : ''}`;

        div.innerHTML = `
            <span class="tab-label" style="user-select: none;">${aba.nome}</span>
            <div class="tab-actions">
                <span class="tab-edit" title="Recarregar Aba" onclick="event.stopPropagation(); window.recarregarAba('${aba.id}')">🔄</span>
                <span class="tab-close" title="Fechar Aba" onclick="event.stopPropagation(); window.fecharAba('${aba.id}')">×</span>
            </div>
        `;

        div.onclick = () => {
            if (aba.externo) { window.open(aba.url, '_blank'); return; }
            abaAtiva = aba.id;
            salvarAbas();
            renderAbas();
        };

        div.ondblclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.renomearAba(aba.id);
        };

        list.appendChild(div);
    });

    // Remove aviso de bloqueio de uma troca de aba anterior
    const avisoAntigo = container.querySelector('.tab-blocked-msg');
    if (avisoAntigo) avisoAntigo.remove();

    const ativa = abas.find(a => a.id === abaAtiva);
    if (!ativa || ativa.externo) {
        frame.style.display = 'none';
        if (!ativa) frame.src = 'about:blank';
        return;
    }
    frame.style.display = 'block';

    if (ativa.url.startsWith('data:text/html')) {
        frame.src = ativa.url;
        return;
    }

    let finalUrl = ativa.url;
    if (finalUrl.startsWith('file:///')) {
        const nomeArquivo = finalUrl.substring(finalUrl.lastIndexOf('/') + 1);
        finalUrl = `pdfs/${nomeArquivo}`;
    }
    // Carrega o PDF direto no iframe (visualizador nativo do navegador),
    // sem depender de nenhum serviço externo precisar acessá-lo pela internet
    if (finalUrl.toLowerCase().endsWith('.pdf')) {
        finalUrl = new URL(finalUrl, window.location.href).href;
    }

    frame.src = finalUrl;
    verificarFrameBloqueado(frame, ativa);
}

function salvarAbas() { localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ abas, abaAtiva })); }

// Detecta se o site de destino recusou ser exibido dentro do iframe
// (X-Frame-Options / CSP frame-ancestors). Não existe evento de erro do
// navegador pra isso, então usamos um truque: depois do 'load', tentamos
// ler a URL interna do iframe.
//   - Se o site foi bloqueado, o navegador nunca trocou o conteúdo, então
//     continua em 'about:blank' — e conseguimos ler isso sem erro.
//   - Se o site carregou de verdade (outra origem), ler .location dispara
//     SecurityError — o que, nesse caso, é o sinal de sucesso.
function verificarFrameBloqueado(iframe, aba) {
    function handler() {
        iframe.removeEventListener('load', handler);
        setTimeout(() => {
            if (aba.id !== abaAtiva) return; // usuário já trocou de aba
            let bloqueado = false;
            try {
                const href = iframe.contentWindow.location.href;
                if (href === 'about:blank') bloqueado = true;
            } catch (e) {
                bloqueado = false; // erro de CORS = carregou conteúdo de outra origem normalmente
            }
            if (bloqueado) mostrarAvisoBloqueio(iframe, aba);
        }, 600);
    }
    iframe.addEventListener('load', handler);
}

function mostrarAvisoBloqueio(iframe, aba) {
    const container = document.getElementById('sheet-container');
    if (container.querySelector('.tab-blocked-msg')) return;

    const host = (() => { try { return new URL(aba.url).hostname; } catch { return 'este site'; } })();

    const aviso = document.createElement('div');
    aviso.className = 'tab-blocked-msg';
    aviso.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--bg-box);text-align:center;padding:24px;';
    aviso.innerHTML = `
        <p style="max-width:320px;">⚠️ O site <b>${host}</b> não permite ser exibido dentro de outra página (bloqueio configurado pelo próprio site).</p>
        <button type="button">Abrir em nova aba</button>
    `;
    aviso.querySelector('button').onclick = () => window.open(aba.url, '_blank');
    container.appendChild(aviso);
    iframe.style.display = 'none';
}

window.fecharAba = (id) => {
    abas = abas.filter(a => a.id !== id);
    if (abaAtiva === id) abaAtiva = abas[0]?.id || null;
    salvarAbas();
    renderAbas();
};

window.recarregarAba = (id) => { if (abaAtiva === id) renderAbas(); };

window.renomearAba = (id) => {
    const aba = abas.find(a => a.id === id);
    if (aba) {
        const novoNome = prompt("Digite o novo nome da aba:", aba.nome);
        if (novoNome && novoNome.trim() !== "") {
            aba.nome = novoNome.trim();
            salvarAbas();
            renderAbas();
        }
    }
};

window.atualizarUrlNovaAba = (id, entradaUsuario) => {
    const aba = abas.find(a => a.id === id);
    if (aba) {
        let texto = entradaUsuario.trim();
        let urlTratada = "";
        let nomeAba = "";

        if (/^https?:\/\//i.test(texto)) {
            urlTratada = texto;
            nomeAba = texto.replace(/^https?:\/\/(www\.)?/, '').substring(0, 15) + '...';
        } else if (/^(www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/i.test(texto)) {
            urlTratada = texto.startsWith('http') ? texto : 'https://' + texto;
            nomeAba = texto.substring(0, 15) + '...';
        } else {
            urlTratada = 'https://searx.be/search?q=' + encodeURIComponent(texto);
            nomeAba = `🔍 ${texto.substring(0, 12)}`;
        }

        aba.url = urlTratada;
        aba.nome = nomeAba;
        salvarAbas();
        renderAbas();
    }
};

window.mudarNomeJogador = (e) => {
    if (e) e.stopPropagation();
    const atual = localStorage.getItem('rpg_user') || 'Jogador';
    const novoNome = prompt("Digite seu nome de exibição para o chat:", atual);
    if (novoNome && novoNome.trim() !== "") {
        localStorage.setItem('rpg_user', novoNome.trim());
        const display = document.getElementById('username-display');
        if (display) display.textContent = novoNome.trim();
    }
};

window.resetarAbas = () => {
    const ok = confirm("Isso vai restaurar as abas padrão (Mansão, Regras, Ficha) e remover as abas personalizadas que você criou. Seu nome de jogador não será afetado. Deseja continuar?");
    if (!ok) return;
    localStorage.removeItem(TABS_STORAGE_KEY);
    location.reload();
};

window.addEventListener('load', async () => {
    const msgContainer = document.getElementById('messages');
    const inputField = document.getElementById('userInput');
    const myUser = localStorage.getItem('rpg_user') || 'Jogador_' + Math.floor(Math.random()*999);
    localStorage.setItem('rpg_user', myUser);

    const diceBtn = document.getElementById('btn-dice');
    if (diceBtn) {
        diceBtn.onclick = () => {
            inputField.value = "/r ";
            inputField.focus();
        };
    }

    const clearBtn = document.getElementById('btn-clear');
    if (clearBtn) {
        clearBtn.removeAttribute('onclick');
        clearBtn.onclick = window.resetarAbas;
    }

    const headerTitle = document.querySelector('#header span');
    if (headerTitle) {
        headerTitle.innerHTML = `⚔️ <span id="username-display" style="cursor:pointer; text-decoration:underline;" title="Clique para mudar seu nome">${myUser}</span>`;
        document.getElementById('username-display').onclick = window.mudarNomeJogador;
    }

    document.getElementById('mobile-switch').onclick = () => {
        document.body.classList.toggle('show-sheet');
        document.getElementById('mobile-switch').textContent = document.body.classList.contains('show-sheet') ? "⚔️ Chat" : "📄 Fichas";
    };

    const { data: hist } = await supabaseClient.from('mensagens').select('*').order('created_at', { ascending: true });
    if (hist) hist.forEach(m => renderMsg(m, msgContainer));

    supabaseClient.channel('chat').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensagens' }, p => renderMsg(p.new, msgContainer)).subscribe();

    await carregarAbas();
    renderAbas();

    async function send() {
        const val = inputField.value.trim(); if (!val) return;
        const currentUser = localStorage.getItem('rpg_user') || myUser;
        let payload = { usuario: currentUser, texto: val, resultado: 0, detalhe: '' };
        if (val.startsWith('/r ')) {
            try { const res = DiceParser.rolar(val.slice(3)); payload.resultado = res.total; payload.detalhe = res.output; } catch(e) { return; }
        }
        inputField.value = '';
        await supabaseClient.from('mensagens').insert([payload]);
    }

    document.getElementById('btn-send').onclick = send;
    inputField.onkeydown = e => { if(e.key === 'Enter') send(); };

    const addTabBtn = document.getElementById('btn-add-tab');
    if (addTabBtn) {
        addTabBtn.removeAttribute('onclick');
        addTabBtn.onclick = () => {
            const id = "c-" + Date.now();
            const htmlConteudo = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body { background: #fff0f5; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 90vh; margin: 0; color: #4a2834; } .search-box { width: 80%; max-width: 500px; text-align: center; } h2 { margin-bottom: 20px; font-weight: normal; color: #ff65a3; } input { width: 100%; padding: 12px 20px; border: 2px solid #fbc2eb; border-radius: 25px; font-size: 16px; outline: none; box-sizing: border-box; } input:focus { border-color: #ff65a3; } p { font-size: 13px; color: #7d4f61; margin-top: 15px; line-height: 1.5; }</style></head><body><div class="search-box"><h2>🌸 Nova Guia</h2><input type="text" id="urlInput" placeholder="Cole um link ou faça sua pesquisa..." autofocus><p>✓ Suporta links diretos<br>✓ Pesquisas abrirão em motor de busca liberado!</p></div><script>document.getElementById('urlInput').onkeydown = function(e) { if(e.key === 'Enter' && this.value.trim() !== "") { window.parent.atualizarUrlNovaAba('${id}', this.value); } }<\/script></body></html>`;

            abas.push({
                id: id,
                nome: "🌸 Nova Guia",
                url: "data:text/html;charset=utf-8," + encodeURIComponent(htmlConteudo)
            });

            abaAtiva = id;
            salvarAbas();
            renderAbas();
        };
    }
});