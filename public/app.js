const API_BASE = window.location.origin;

function checkAuth() {
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('authToken');
    const headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
    };
    
    const response = await fetch(url, { ...options, headers });
    
    if (response.status === 401) {
        localStorage.removeItem('authToken');
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
    }
    
    return response;
}

async function loadDashboard() {
    if (!checkAuth()) return;

    try {
        const [healthResponse, statusResponse] = await Promise.all([
            fetchWithAuth(`${API_BASE}/api/health`),
            fetchWithAuth(`${API_BASE}/api/status`)
        ]);

        const health = await healthResponse.json();
        const status = await statusResponse.json();

        document.getElementById('serverStatus').textContent = status.serverStatus;
        document.getElementById('totalRooms').textContent = health.totalRooms;
        document.getElementById('totalUsers').textContent = health.totalUsers;

        const roomsList = document.getElementById('roomsList');
        
        if (health.totalRooms === 0) {
            roomsList.innerHTML = '<p class="no-data">No active meetings</p>';
        } else {
            const roomsHtml = Object.entries(health.usersPerRoom).map(([roomId, count]) => `
                <div class="room-card">
                    <div class="room-header">
                        <span class="room-id">Room: ${roomId}</span>
                        <span class="room-status">Live</span>
                    </div>
                    <div class="room-participants">
                        <span>👥</span>
                        <span>${count} participant${count !== 1 ? 's' : ''}</span>
                    </div>
                </div>
            `).join('');
            roomsList.innerHTML = roomsHtml;
        }

        document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
    } catch (error) {
        console.error('Error loading dashboard:', error);
        document.getElementById('serverStatus').textContent = 'Error connecting';
    }
}

document.getElementById('refreshBtn').addEventListener('click', loadDashboard);

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('authToken');
    window.location.href = '/login.html';
});

loadDashboard();

setInterval(loadDashboard, 5000);