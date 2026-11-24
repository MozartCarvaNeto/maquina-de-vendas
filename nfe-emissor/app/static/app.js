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
  // O <select> original continua sendo o campo enviado ao servidor (fica oculto);
  // o campo de texto + lista de sugestões apenas escolhe a opção dele.
  var MAX_SUGESTOES = 50;

  function normalizar(t) {
    return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }
  function soDigitos(t) { return String(t || "").replace(/\D/g, ""); }

  function iniciarBusca(select) {
    if (select.dataset.buscaOk) return;
    select.dataset.buscaOk = "1";

    var obrigatorio = select.required;
    var itens = [];
    Array.prototype.forEach.call(select.options, function (o) {
      if (!o.value) return; // ignora "Selecione..."
      var rotulo = o.textContent.replace(/\s+/g, " ").trim();
      itens.push({ valor: o.value, rotulo: rotulo, norm: normalizar(rotulo), dig: soDigitos(rotulo) });
    });

    var wrap = document.createElement("div");
    wrap.className = "cb";
    var input = document.createElement("input");
    input.type = "text";
    input.className = "cb-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = select.dataset.busca || "Digite para buscar...";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.required = obrigatorio;
    wrap.appendChild(input);
    // o campo de texto vem ANTES do select para ser o alvo do <label>
    select.parentNode.insertBefore(wrap, select);
    select.hidden = true;
    select.required = false; // a validação passa a ser do campo de texto
    select.tabIndex = -1;

    var lista = document.createElement("ul");
    lista.className = "cb-lista";
    lista.setAttribute("role", "listbox");
    lista.hidden = true;
    document.body.appendChild(lista);

    var resultados = [];
    var ativo = -1;
    var aberta = false;
    var digitou = false;

    function rotuloAtual() {
      var o = select.selectedOptions && select.selectedOptions[0];
      return o && o.value ? o.textContent.replace(/\s+/g, " ").trim() : "";
    }

    function validar() {
      var txt = input.value.trim();
      if (txt && !select.value) input.setCustomValidity("Escolha um item da lista de sugestões.");
      else input.setCustomValidity("");
    }

    function filtrar(consulta) {
      var q = normalizar(consulta).trim();
      if (!q) return itens.slice();
      var termos = q.split(/\s+/);
      var achados = itens.filter(function (it) {
        return termos.every(function (t) {
          if (it.norm.indexOf(t) >= 0) return true;
          var td = soDigitos(t); // CPF/CNPJ digitado com ou sem pontuação
          return td.length >= 3 && td.length === t.replace(/[.\-\/]/g, "").length && it.dig.indexOf(td) >= 0;
        });
      });
      // quem começa com o texto digitado aparece primeiro
      var comeca = [], resto = [];
      achados.forEach(function (it) { (it.norm.indexOf(q) === 0 ? comeca : resto).push(it); });
      return comeca.concat(resto);
    }

    function posicionar() {
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

    function marcarAtivo(i, rolar) {
      ativo = i;
      var lis = lista.querySelectorAll("li[data-i]");
      lis.forEach(function (li) {
        var on = Number(li.dataset.i) === i;
        li.classList.toggle("ativo", on);
        li.setAttribute("aria-selected", on ? "true" : "false");
        if (on && rolar) li.scrollIntoView({ block: "nearest" });
      });
    }

    function desenhar() {
      var consulta = digitou ? input.value : "";
      var todos = filtrar(consulta);
      resultados = todos.slice(0, MAX_SUGESTOES);
      lista.textContent = "";
      resultados.forEach(function (it, i) {
        var li = document.createElement("li");
        li.setAttribute("role", "option");
        li.dataset.i = String(i);
        li.textContent = it.rotulo;
        if (String(it.valor) === String(select.value)) li.classList.add("atual");
        lista.appendChild(li);
      });
      if (!resultados.length) {
        var vazio = document.createElement("li");
        vazio.className = "cb-aviso";
        vazio.textContent = itens.length ? "Nada encontrado para o que foi digitado." : "Nenhum item cadastrado.";
        lista.appendChild(vazio);
      } else if (todos.length > resultados.length) {
        var mais = document.createElement("li");
        mais.className = "cb-aviso";
        mais.textContent = "Mostrando " + resultados.length + " de " + todos.length + ". Continue digitando para refinar.";
        lista.appendChild(mais);
      }
      marcarAtivo(resultados.length && digitou ? 0 : -1, false);
      if (!digitou && select.value) {
        var idx = resultados.findIndex(function (it) { return String(it.valor) === String(select.value); });
        if (idx >= 0) marcarAtivo(idx, true);
      }
      posicionar();
    }

    function abrir() {
      aberta = true;
      lista.hidden = false;
      input.setAttribute("aria-expanded", "true");
      desenhar();
    }
    function fechar() {
      aberta = false;
      lista.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }

    function escolher(item) {
      select.value = item.valor;
      input.value = item.rotulo;
      digitou = false;
      fechar();
      validar();
      select.dispatchEvent(new Event("change", { bubbles: true })); // preenche o preço, recalcula etc.
    }

    input.addEventListener("input", function () {
      digitou = true;
      var mudou = select.value !== "";
      select.value = ""; // texto editado: a escolha anterior deixa de valer
      validar();
      if (mudou) select.dispatchEvent(new Event("change", { bubbles: true }));
      abrir();
    });
    input.addEventListener("paste", function () {
      // texto colado: se só houver um cadastro correspondente, já seleciona
      setTimeout(function () {
        if (!select.value && input.value.trim() && resultados.length === 1) escolher(resultados[0]);
      }, 0);
    });
    input.addEventListener("focus", function () {
      input.select();
      digitou = false;
      abrir();
    });
    input.addEventListener("click", function () { if (!aberta) abrir(); });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (!aberta) { abrir(); return; }
        if (resultados.length) marcarAtivo(Math.min(ativo + 1, resultados.length - 1), true);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (aberta && resultados.length) marcarAtivo(Math.max(ativo - 1, 0), true);
      } else if (ev.key === "Enter") {
        if (aberta) {
          ev.preventDefault(); // não envia o formulário enquanto a lista está aberta
          var alvo = resultados[ativo >= 0 ? ativo : 0];
          if (alvo && (digitou || ativo >= 0)) escolher(alvo);
          else fechar();
        }
      } else if (ev.key === "Escape") {
        if (aberta) { ev.preventDefault(); fechar(); }
        if (select.value) input.value = rotuloAtual();
      }
    });
    input.addEventListener("blur", function () {
      fechar();
      if (select.value) {
        input.value = rotuloAtual();
      } else if (input.value.trim()) {
        var achados = filtrar(input.value);
        if (achados.length === 1) escolher(achados[0]);
      }
      validar();
    });

    // clicar numa sugestão (mousedown evita que o campo perca o foco antes)
    lista.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      var li = ev.target.closest("li[data-i]");
      if (li) escolher(resultados[Number(li.dataset.i)]);
    });
    lista.addEventListener("mousemove", function (ev) {
      var li = ev.target.closest("li[data-i]");
      if (li && Number(li.dataset.i) !== ativo) marcarAtivo(Number(li.dataset.i), false);
    });

    window.addEventListener("resize", function () { if (aberta) posicionar(); });
    window.addEventListener("scroll", function () { if (aberta) posicionar(); }, true);
    window.addEventListener("pageshow", function () { input.value = rotuloAtual(); validar(); });

    input.value = rotuloAtual();
    validar();
  }

  function iniciarBuscas(raiz) {
    (raiz || document).querySelectorAll("select[data-busca]").forEach(iniciarBusca);
  }
  iniciarBuscas(document);

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
  tabela.addEventListener("change", function (ev) {
    if (ev.target.classList.contains("sel-produto")) {
      var opt = ev.target.selectedOptions[0];
      var vun = ev.target.closest("tr").querySelector(".vun");
      if (opt && opt.dataset.preco && !vun.value) {
        vun.value = String(opt.dataset.preco).replace(".", ",");
      }
      recalcular();
    }
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
    iniciarBuscas(tabela);
    var campos = tabela.querySelectorAll("tr.item:last-child .cb-input");
    if (campos.length) campos[0].focus();
    recalcular();
  });
  ["valor_desconto", "valor_frete", "valor_outras"].forEach(function (n) {
    document.getElementById("form-nota").elements[n].addEventListener("input", recalcular);
  });
  recalcular();
})();
