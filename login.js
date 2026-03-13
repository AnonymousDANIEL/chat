document.getElementById("btn").onclick = async () => {
    const username = document.getElementById("u").value.trim();
    const password = document.getElementById("p").value.trim();
    const err = document.getElementById("err");
    err.style.display = "none";

    const r = await fetch("/api/login", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ username, password })
    });

    if (r.ok) location.href = "/dashboard.html";
    else {
        err.textContent = "Bad credentials";
        err.style.display = "block";
    }
};