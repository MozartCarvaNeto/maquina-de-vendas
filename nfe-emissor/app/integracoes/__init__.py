"""Integração com lojas virtuais: busca pedidos e entrega num formato único.

Formato normalizado de um pedido (dict):
  externo_id, numero, data, pago (bool|None), total, frete, desconto, pagamento ('17','03',...),
  obs, cliente {documento, nome, email, fone, cep, logradouro, numero, complemento, bairro,
  municipio, uf}, itens [{sku, descricao, quantidade, preco}]
Os valores monetários são strings decimais.
"""
from . import mercadolivre, nuvemshop, shopify, woocommerce
from .base import ErroIntegracao

PLATAFORMAS = {
    "nuvemshop": nuvemshop,
    "shopify": shopify,
    "woocommerce": woocommerce,
    "mercadolivre": mercadolivre,
}
__all__ = ["PLATAFORMAS", "ErroIntegracao"]
