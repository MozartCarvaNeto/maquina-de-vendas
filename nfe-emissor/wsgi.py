"""Ponto de entrada para servidores WSGI (gunicorn): `gunicorn wsgi:app`."""
from app import create_app

app = create_app()
