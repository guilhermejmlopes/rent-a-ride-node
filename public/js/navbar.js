window.addEventListener('DOMContentLoaded', async () => {
	try {
		const response = await fetch('/perfil', {
			method: 'GET',
			credentials: 'include'
		});

		if (response.ok) {
			// Sessão ativa
			document.getElementById('nav-login').style.display = 'none';
			document.getElementById('nav-logout').style.display = 'block';
			document.getElementById('nav-alugueres').style.display = 'block';

			// Logout handler
			document.getElementById('logout-link').addEventListener('click', async (e) => {
				e.preventDefault();
				await fetch('/logout', {
					method: 'POST',
					credentials: 'include'
				});
				location.reload();
			});
		} else {
			// Não autenticado
			document.getElementById('nav-login').style.display = 'block';
			document.getElementById('nav-logout').style.display = 'none';
			document.getElementById('nav-alugueres').style.display = 'none';
		}
	} catch (err) {
		console.error('Erro ao verificar sessão:', err);
	}
});