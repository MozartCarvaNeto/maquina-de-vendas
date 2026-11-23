"""Emissor de NF-e - fábrica da aplicação Flask (versão multiconta, dentro do Turbo Prospect)."""
import os

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix

from . import db as dbmod
from . import security, tenant
from .config import Config


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)

    # Atrás do Turbo Prospect (proxy em /nfe-app): enxerga o HTTPS, o domínio e o prefixo reais
    if os.environ.get("BEHIND_PROXY", "0") == "1":
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

    dbmod.init_db(app)

    from .views import bp
    app.register_blueprint(bp)
    app.before_request(tenant.autenticar)
    app.before_request(security.verificar_csrf)
    app.jinja_env.globals["csrf_token"] = security.csrf_token

    @app.after_request
    def cabecalhos_de_seguranca(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        # O emissor aparece dentro de uma aba do Turbo Prospect (mesmo domínio): permite só isso.
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["Referrer-Policy"] = "same-origin"
        if resp.mimetype == "text/html":
            resp.headers["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' data:; frame-ancestors 'self'; "
                "form-action 'self'")
            resp.headers["Cache-Control"] = "no-store"
        return resp

    return app
