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
    recalcular();
  });
  ["valor_desconto", "valor_frete", "valor_outras"].forEach(function (n) {
    document.getElementById("form-nota").elements[n].addEventListener("input", recalcular);
  });
  recalcular();
})();
