"""Vitual XRing Python SDK 14.0.0
与 vtx-sdk.js 对齐的轻量 Python 移植。
用法：
    from vtx_sdk import VTX
    vtx = VTX("https://xsmmc.caldson.us.ci")
    session = vtx.login("账户", "密码")
    print(session["account"]["money"])
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class VTXError(Exception):
    def __init__(self, message: str, status: int = 0, code: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class VTX:
    def __init__(self, base_url: str = "https://xsmmc.caldson.us.ci") -> None:
        self.base_url = base_url.rstrip("/")
        self.token: Optional[str] = None
        self.account: Optional[dict] = None

    def _request(self, path: str, method: str = "GET", body: Any = None, auth: bool = True) -> Any:
        headers = {"accept": "application/json"}
        if body is not None:
            headers["content-type"] = "application/json"
        if auth and self.token:
            headers["authorization"] = f"Bearer {self.token}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {}
            raise VTXError(payload.get("message") or f"HTTP {error.code}", error.code, payload.get("error", "")) from error
        except urllib.error.URLError as error:
            raise VTXError(f"无法连接 VTX API：{error.reason}") from error

    # 会话
    def login(self, login: str, password: str) -> dict:
        data = self._request("/api/login", "POST", {"login": login, "password": password}, auth=False)
        self.token = data.get("token")
        self.account = data.get("account")
        return data

    def register(self, login: str, password: str, username: str = "") -> dict:
        data = self._request("/api/register", "POST", {"login": login, "password": password, "username": username}, auth=False)
        self.token = data.get("token") or self.token
        self.account = data.get("account")
        return data

    def set_token(self, token: str) -> None:
        self.token = token or None

    def logout(self) -> None:
        self.token = None
        self.account = None

    def is_logged_in(self) -> bool:
        return bool(self.token)

    def me(self) -> dict:
        return self._request("/api/me")

    def accounts(self) -> dict:
        return self._request("/api/accounts")

    def account_info(self, login: str) -> dict:
        return self._request(f"/api/accounts/{urllib.parse.quote(login)}")

    # 游戏数据
    def set_data(self, game: str, values: dict) -> dict:
        return self._request(f"/api/me/data/{urllib.parse.quote(game)}", "PUT", values)

    def get_data(self, game: str) -> Any:
        return self._request(f"/api/me/data/{urllib.parse.quote(game)}")

    def delete_data(self, game: str, key: str = "") -> dict:
        path = f"/api/me/data/{urllib.parse.quote(game)}"
        if key:
            path += "/" + urllib.parse.quote(key)
        return self._request(path, "DELETE")

    # 交易
    def trade(self, type: str, amount: str, party: str, description: str = "", name: str = "", password: str = "") -> dict:
        return self._request("/api/me/trades", "POST", {
            "type": type, "amount": amount, "party": party,
            "description": description, "name": name, "password": password,
        })

    def pay(self, amount: str, party: str, description: str = "", name: str = "", password: str = "") -> dict:
        return self.trade("payment", amount, party, description, name, password)

    def receive(self, amount: str, party: str, description: str = "", name: str = "") -> dict:
        return self.trade("receipt", amount, party, description, name)

    # 收款码
    def create_receipt_code(self, amount: str = "") -> dict:
        body = {} if not amount else {"amount": amount}
        return self._request("/api/me/receipt-code", "POST", body)

    def receipt_code(self) -> dict:
        return self._request("/api/me/receipt-code")

    def revoke_receipt_code(self) -> dict:
        return self._request("/api/me/receipt-code", "DELETE")

    def receipt_code_info(self, code: str) -> dict:
        return self._request(f"/api/receipt-codes/{urllib.parse.quote(code)}")

    def pay_receipt_code(self, code: str, password: str, amount: str = "", description: str = "") -> dict:
        return self._request(f"/api/receipt-codes/{urllib.parse.quote(code)}/pay", "POST", {
            "password": password, "amount": amount, "description": description,
        })

    # 社交
    def social_resolve(self, url: str) -> dict:
        return self._request("/api/social/resolve?url=" + urllib.parse.quote(url, safe=""))

    def social_list(self, kind: str, **options: Any) -> dict:
        query = urllib.parse.urlencode({k: v for k, v in options.items() if v not in (None, "")})
        return self._request(f"/api/social/kinds/{urllib.parse.quote(kind)}" + (("?" + query) if query else ""))

    def social_get(self, kind: str, item_id: str) -> dict:
        return self._request(f"/api/social/kinds/{urllib.parse.quote(kind)}/{urllib.parse.quote(str(item_id))}")

    def social_share(self, payload: dict) -> dict:
        return self._request("/api/social/shares", "POST", payload)

    def social_share_get(self, share_id: str) -> dict:
        return self._request(f"/api/social/shares/{urllib.parse.quote(share_id)}")

    def social_meeting(self, number: str) -> dict:
        return self._request(f"/api/social/meetings/{urllib.parse.quote(number)}")
