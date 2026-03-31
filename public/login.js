const DEFAULT_API_BASE = (() => {
    const currentPath = window.location.pathname || "/";
    const loginSuffix = "/login.html";

    if (currentPath.endsWith(loginSuffix)) {
        return currentPath.slice(0, -loginSuffix.length) || "/";
    }

    return "/";
})();

const API_BASE = (window.__RTC_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");

function buildApiUrl(path) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    if (!API_BASE || API_BASE === "/") {
        return normalizedPath;
    }
    return `${API_BASE}${normalizedPath}`;
}

async function parseResponsePayload(response) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        return response.json();
    }

    const text = await response.text();
    return { error: text || `Request failed with status ${response.status}` };
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('error');
    
    try {
        const response = await fetch(buildApiUrl("/api/login"), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await parseResponsePayload(response);
        
        if (response.ok) {
            localStorage.setItem('authToken', data.token);
            window.location.href = buildApiUrl('/');
        } else {
            errorEl.textContent = data.error || 'Login failed';
        }
    } catch (error) {
        errorEl.textContent = error instanceof Error ? error.message : 'Error connecting to server';
    }
});

if (localStorage.getItem('authToken')) {
    window.location.href = buildApiUrl('/');
}
