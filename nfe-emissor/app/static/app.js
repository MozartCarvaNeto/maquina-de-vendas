(function () {
  "use strict";

  // Confirmação em botões com data-confirm
  document.addEventListener("click", function (ev) {
    var alvo = ev.target.closest("[data-confirm]");
    if (alvo && !window.confirm(alvo.getAttribute("data-confirm"))) {
      ev.preventDefault();
    }
  });

  // Evita envio duplo (emitir pode demorar até 1 minuto)
  document.addEventListener("submit", function (ev) {
    var botoes = ev.target.querySelectorAll("button[type=submit]");
    setTimeout(function () {
      botoes.forEach(function (b) { b.disabled = true; });
    }, 0);
  });

  // Buscar CEP: preenche endereço e código IBGE
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-buscar-cep]");
    if (!btn) return;
    var form = btn.closest("form");
    var cep = (form.elements["cep"].value || "").replace(/\D/g, "");
    if (cep.length !== 8) { window.alert("Informe um CEP com 8 dígitos."); return; }
    btn.disabled = true;
    fetch((document.body.dataset.base || "") + "/api/cep/" + cep, { credentials: "same-origin" })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { window.alert(res.d.erro || "Erro ao consultar o CEP."); return; }
        ["logradouro", "bairro", "municipio", "uf", "cod_municipio"].forEach(function (nome) {
          if (form.elements[nome] && res.d[nome]) form.elements[nome].value = res.d[nome];
        });
      })
      .catch(function () { window.alert("Não foi possível consultar o CEP agora."); })
      .finally(function () { btn.disabled = false; });
  });

  // ---- Campos com busca (cliente e produto): digite ou cole para filtrar ----
  // A busca é feita NO SERVIDOR (só os primeiros 50 resultados), então a página continua leve com
  // milhares de cadastros. Um único tratador de eventos no documento atende todos os campos
  // (inclusive as linhas de itens adicionadas depois) e existe uma única lista flutuante.
  var ESPERA_MS = 180;
  var cacheBusca = new Map();
  var lista = null;       // <ul> flutuante compartilhada
  var aberto = null;      // campo de texto com a lista aberta

  function base() { return document.body.dataset.base || ""; }

  function estado(input) {
    if (!input._cb) {
      var box = input.closest(".cb");
      input._cb = {
        box: box, valor: box.querySelector(".cb-valor"), url: box.dataset.url,
        itens: [], mais: false, ativo: -1, seq: 0, timer: null, ctrl: null, colou: false, digitou: false,
        termoPronto: null, escolherAoChegar: false,
      };
      input._cb.rotulo = input.value; // rótulo da escolha salva (volta a ele se a pessoa desistir)
    }
    return input._cb;
  }

  function criarLista() {
    if (lista) return lista;
    lista = document.createElement("ul");
    lista.className = "cb-lista";
    lista.setAttribute("role", "listbox");
    lista.hidden = true;
    document.body.appendChild(lista);
    // mousedown (e não click) evita que o campo perca o foco antes da escolha
    lista.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      var li = ev.target.closest("li[data-i]");
      if (li && aberto) escolher(aberto, estado(aberto).itens[Number(li.dataset.i)]);
    });
    lista.addEventListener("mousemove", function (ev) {
      var li = ev.target.closest("li[data-i]");
      if (li && aberto && Number(li.dataset.i) !== estado(aberto).ativo) marcar(aberto, Number(li.dataset.i), false);
    });
    window.addEventListener("resize", function () { if (aberto) posicionar(aberto); });
    window.addEventListener("scroll", function (ev) {
      if (aberto && !(lista && lista.contains(ev.target))) posicionar(aberto);
    }, true);
    return lista;
  }

  function posicionar(input) {
    var r = input.getBoundingClientRect();
    var abaixo = window.innerHeight - r.bottom;
    lista.style.left = Math.max(0, r.left) + "px";
    lista.style.minWidth = r.width + "px";
    lista.style.maxWidth = Math.max(r.width, Math.min(640, window.innerWidth - 16)) + "px";
    if (abaixo < 220 && r.top > abaixo) { // sem espaço embaixo: abre para cima
      lista.style.top = "auto";
      lista.style.bottom = (window.innerHeight - r.top + 2) + "px";
      lista.style.maxHeight = Math.max(120, Math.min(280, r.top - 12)) + "px";
    } else {
      lista.style.bottom = "auto";
      lista.style.top = (r.bottom + 2) + "px";
      lista.style.maxHeight = Math.max(120, Math.min(280, abaixo - 12)) + "px";
    }
  }

  function validar(input) {
    var st = estado(input);
    input.setCustomValidity(input.value.trim() && !st.valor.value ? "Escolha um item da lista de sugestões." : "");
  }

  function marcar(input, i, rolar) {
    var st = estado(input);
    st.ativo = i;
    lista.querySelectorAll("li[data-i]").forEach(function (li) {
      var on = Number(li.dataset.i) === i;
      li.classList.toggle("ativo", on);
      li.setAttribute("aria-selected", on ? "true" : "false");
      if (on && rolar) li.scrollIntoView({ block: "nearest" });
    });
  }

  function aviso(texto) {
    var li = document.createElement("li");
    li.className = "cb-aviso";
    li.textContent = texto;
    lista.appendChild(li);
  }

  function desenhar(input, carregando, erro) {
    var st = estado(input);
    criarLista();
    lista.textContent = "";
    st.itens.forEach(function (it, i) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.i = String(i);
      li.textContent = it.rotulo;
      if (String(it.id) === String(st.valor.value)) li.classList.add("atual");
      lista.appendChild(li);
    });
    if (erro) aviso("Não foi possível buscar agora. Tente de novo.");
    else if (carregando && !st.itens.length) aviso("Buscando...");
    else if (!st.itens.length) aviso(input.value.trim() ? "Nada encontrado para o que foi digitado." : "Nenhum item cadastrado.");
    else if (st.mais) aviso("Mostrando os " + st.itens.length + " primeiros. Continue digitando para refinar.");
    marcar(input, st.itens.length && st.digitou ? 0 : -1, false);
    lista.hidden = false;
    posicionar(input);
  }

  function buscar(input, termo, aoTerminar) {
    var st = estado(input);
    var chave = st.url + "|" + termo;
    var minha = ++st.seq;
    if (st.ctrl) st.ctrl.abort();
    if (cacheBusca.has(chave)) { aoTerminar(cacheBusca.get(chave), minha === st.seq); return; }
    st.ctrl = window.AbortController ? new AbortController() : null;
    fetch(st.url + "?q=" + encodeURIComponent(termo), { credentials: "same-origin", signal: st.ctrl ? st.ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (d) {
        if (cacheBusca.size > 150) cacheBusca.clear();
        cacheBusca.set(chave, d);
        aoTerminar(d, minha === st.seq);
      })
      .catch(function (e) { if (e && e.name === "AbortError") return; aoTerminar(null, minha === st.seq); });
  }

  function atualizar(input, imediato) {
    var st = estado(input);
    clearTimeout(st.timer);
    var termo = st.digitou ? input.value.trim() : "";
    if (st.termoPronto !== termo) {                // a lista antiga não vale para o texto novo
      st.itens = [];
      if (!imediato && aberto === input) desenhar(input, true, false);   // mostra "Buscando..." na hora
    }
    function rodar() {
      desenhar(input, true, false);
      buscar(input, termo, function (dados, vigente) {
        if (!vigente) return;
        if (!dados) { st.itens = []; if (aberto === input) desenhar(input, false, true); return; }
        st.itens = dados.itens || [];
        st.mais = !!dados.mais;
        st.termoPronto = termo;
        if (aberto === input) desenhar(input, false, false);
        // Enter apertado antes da busca voltar: escolhe o primeiro resultado da busca ATUAL
        if (st.escolherAoChegar && st.digitou && st.itens.length) { st.escolherAoChegar = false; escolher(input, st.itens[0]); return; }
        st.escolherAoChegar = false;
        // texto colado que corresponde a um único cadastro: já seleciona
        if (st.colou && st.itens.length === 1 && !st.mais && !st.valor.value) escolher(input, st.itens[0]);
        st.colou = false;
      });
    }
    if (imediato) rodar(); else st.timer = setTimeout(rodar, ESPERA_MS);
  }

  function abrir(input) {
    aberto = input;
    input.setAttribute("aria-expanded", "true");
    atualizar(input, true);
  }

  function fechar(input) {
    if (aberto === input) aberto = null;
    input.setAttribute("aria-expanded", "false");
    if (lista) lista.hidden = true;
  }

  function escolher(input, item) {
    if (!item) return;
    var st = estado(input);
    clearTimeout(st.timer);
    st.valor.value = item.id;
    st.rotulo = item.rotulo;
    input.value = item.rotulo;
    st.digitou = false;
    st.colou = false;
    fechar(input);
    validar(input);
    st.valor.dispatchEvent(new CustomEvent("cb:escolhido", { bubbles: true, detail: item })); // preço, totais...
  }

  document.addEventListener("input", function (ev) {
    var input = ev.target;
    if (!input.classList || !input.classList.contains("cb-input")) return;
    var st = estado(input);
    st.digitou = true;
    st.escolherAoChegar = false;
    st.valor.value = ""; // texto editado: a escolha anterior deixa de valer
    validar(input);
    aberto = input;
    input.setAttribute("aria-expanded", "true");
    atualizar(input, false);
  });
  document.addEventListener("paste", function (ev) {
    if (ev.target.classList && ev.target.classList.contains("cb-input")) estado(ev.target).colou = true;
  });
  document.addEventListener("focusin", function (ev) {
    var input = ev.target;
    if (!input.classList || !input.classList.contains("cb-input")) return;
    estado(input).digitou = false;
    input.select();
    abrir(input);
  });
  document.addEventListener("focusout", function (ev) {
    var input = ev.target;
    if (!input.classList || !input.classList.contains("cb-input")) return;
    var st = estado(input);
    clearTimeout(st.timer);
    fechar(input);
    if (st.valor.value) {
      input.value = st.rotulo;
    } else if (input.value.trim()) {
      st.colou = true; // se a busca achar um só cadastro, seleciona
      atualizar(input, true);
      fechar(input);
    }
    validar(input);
  });
  document.addEventListener("keydown", function (ev) {
    var input = ev.target;
    if (!input.classList || !input.classList.contains("cb-input")) return;
    var st = estado(input);
    var abertaAgora = aberto === input && lista && !lista.hidden;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (!abertaAgora) { abrir(input); return; }
      if (st.itens.length) marcar(input, Math.min(st.ativo + 1, st.itens.length - 1), true);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (abertaAgora && st.itens.length) marcar(input, Math.max(st.ativo - 1, 0), true);
    } else if (ev.key === "Enter") {
      if (abertaAgora) {
        ev.preventDefault(); // não envia o formulário enquanto a lista está aberta
        var atual = st.termoPronto === (st.digitou ? input.value.trim() : "");
        if (st.digitou && !atual) { st.escolherAoChegar = true; return; } // espera a busca terminar
        var alvo = st.itens[st.ativo >= 0 ? st.ativo : 0];
        if (alvo && (st.digitou || st.ativo >= 0)) escolher(input, alvo); else fechar(input);
      }
    } else if (ev.key === "Escape") {
      if (abertaAgora) { ev.preventDefault(); fechar(input); }
      if (st.valor.value) input.value = st.rotulo;
    }
  });
  document.addEventListener("click", function (ev) {
    var input = ev.target.closest && ev.target.closest(".cb-input");
    if (input && aberto !== input) abrir(input);
  });

  // ---- Formulário de nota: linhas de itens e total ----
  var tabela = document.getElementById("itens");
  if (!tabela) return;

  function num(texto) {
    var s = String(texto || "").trim().replace("R$", "").replace(/\s/g, "");
    if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  function brl(n) {
    return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function recalcular() {
    var soma = 0;
    tabela.querySelectorAll("tr.item").forEach(function (tr) {
      var sub = Math.round(num(tr.querySelector(".qtd").value) * num(tr.querySelector(".vun").value) * 100) / 100;
      tr.querySelector(".sub").textContent = brl(sub);
      soma += sub;
    });
    var f = document.getElementById("form-nota").elements;
    var total = soma - num(f["valor_desconto"].value) + num(f["valor_frete"].value) + num(f["valor_outras"].value);
    document.getElementById("total-nota").textContent = "R$ " + brl(total);
  }

  tabela.addEventListener("input", recalcular);
  tabela.addEventListener("cb:escolhido", function (ev) {
    if (ev.target.name !== "produto_id") return;
    var vun = ev.target.closest("tr").querySelector(".vun");
    var preco = ev.detail && ev.detail.preco;
    if (preco && !vun.value) vun.value = String(preco).replace(".", ",");
    recalcular();
  });
  tabela.addEventListener("click", function (ev) {
    if (ev.target.classList.contains("rem")) {
      var linhas = tabela.querySelectorAll("tr.item");
      if (linhas.length > 1) ev.target.closest("tr").remove(); else window.alert("A nota precisa de ao menos um item.");
      recalcular();
    }
  });
  document.getElementById("add-item").addEventListener("click", function () {
    var tpl = document.getElementById("tpl-item");
    tabela.appendChild(tpl.content.cloneNode(true));
    var campos = tabela.querySelectorAll("tr.item:last-child .cb-input");
    if (campos.length) campos[0].focus();
    recalcular();
  });
  ["valor_desconto", "valor_frete", "valor_outras"].forEach(function (n) {
    document.getElementById("form-nota").elements[n].addEventListener("input", recalcular);
  });
  recalcular();
})();
