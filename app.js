let cart = [];
let currentCategory = 'All';
const TAX_RATE = 0.05; // 5%

// UI Elements
const productGrid = document.getElementById('product-grid');
const cartItemsContainer = document.getElementById('cart-items');
const subtotalEl = document.getElementById('subtotal');
const taxEl = document.getElementById('tax');
const totalEl = document.getElementById('total');
const categoryFilters = document.getElementById('category-filters');
const searchInput = document.getElementById('search-input');

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
    updateClock();
    setInterval(updateClock, 1000);
    
    // Give time for db to seed if fresh
    setTimeout(async () => {
        await renderCategories();
        await loadProducts();
        renderCart();
    }, 500);

    // Search listener
    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        filterProductsBySearch(term);
    });
});

// Update Clock
function updateClock() {
    const now = new Date();
    document.getElementById('clock').innerText = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('date').innerText = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Render Categories
async function renderCategories() {
    const categories = await db.categories.toArray();
    let html = `<button class="cat-btn px-6 py-2 rounded-full font-medium text-sm transition-all shadow-[0_0_15px_rgba(99,102,241,0.4)] bg-primary text-white border border-primary/50" data-cat="All" onclick="filterCategory('All')">All Items</button>`;
    
    categories.forEach(cat => {
        html += `<button class="cat-btn px-6 py-2 rounded-full font-medium text-sm transition-all shadow-md bg-cardBg text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500 hover:shadow-[0_0_10px_rgba(255,255,255,0.1)]" data-cat="${cat.name}" onclick="filterCategory('${cat.name}')">${cat.name}</button>`;
    });
    
    categoryFilters.innerHTML = html;
}

// Filter Category
window.filterCategory = (cat) => {
    currentCategory = cat;
    document.querySelectorAll('.cat-btn').forEach(btn => {
        if(btn.dataset.cat === cat) {
            btn.className = "cat-btn px-6 py-2 rounded-full font-medium text-sm transition-all shadow-[0_0_15px_rgba(99,102,241,0.4)] bg-primary text-white border border-primary/50";
        } else {
            btn.className = "cat-btn px-6 py-2 rounded-full font-medium text-sm transition-all shadow-md bg-cardBg text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500 hover:shadow-[0_0_10px_rgba(255,255,255,0.1)]";
        }
    });
    loadProducts();
    searchInput.value = ''; // clear search when changing category
}

// Filter Search
function filterProductsBySearch(term) {
    const allCards = document.querySelectorAll('#product-grid > div');
    allCards.forEach(card => {
        const title = card.querySelector('h3').innerText.toLowerCase();
        const sku = card.querySelector('p').innerText.toLowerCase();
        if(title.includes(term) || sku.includes(term)) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

// Load Products from DB
async function loadProducts() {
    const products = await db.products.toArray();
    productGrid.innerHTML = '';
    
    products.forEach(p => {
        if(currentCategory !== 'All' && p.category !== currentCategory) return;
        
        const card = document.createElement('div');
        card.className = 'bg-cardBg p-4 rounded-2xl shadow-md hover:shadow-[0_10px_20px_rgba(0,0,0,0.3)] transition-all cursor-pointer transform hover:-translate-y-1 border border-slate-800 hover:border-primary/50 group animate-slide-in';
        card.onclick = () => addToCart(p);
        
        const stockStatus = p.stock_qty <= 5 
            ? `<div class="absolute top-2 right-2 bg-red-500/80 backdrop-blur-md text-white text-xs px-2 py-1 rounded-md font-medium border border-red-400/50 shadow-sm"><i class="fas fa-exclamation-triangle mr-1"></i> Low: ${p.stock_qty}</div>`
            : `<div class="absolute top-2 right-2 bg-dark/60 backdrop-blur-md text-white text-xs px-2 py-1 rounded-md font-medium border border-slate-600/50 shadow-sm">Qty: ${p.stock_qty}</div>`;

        card.innerHTML = `
            <div class="h-44 bg-slate-800 rounded-xl mb-4 overflow-hidden relative shadow-inner">
                <img src="${p.image}" class="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-110 transition-all duration-500" alt="${p.name}" loading="lazy">
                ${stockStatus}
                <div class="absolute inset-0 bg-gradient-to-t from-dark/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                    <span class="text-xs text-white bg-primary/80 px-2 py-1 rounded-md backdrop-blur-sm"><i class="fas fa-plus mr-1"></i>Add Item</span>
                </div>
            </div>
            <h3 class="font-semibold text-slate-100 truncate text-[15px] group-hover:text-primary transition-colors">${p.name}</h3>
            <p class="text-xs text-slate-400 mb-3 font-mono">SKU: ${p.sku}</p>
            <div class="flex justify-between items-center">
                <span class="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-primary to-primaryHover">Rs. ${p.retail_price.toLocaleString()}</span>
                <button class="w-8 h-8 flex items-center justify-center bg-slate-800 text-slate-300 group-hover:bg-primary group-hover:text-white rounded-lg transition-all shadow-sm">
                    <i class="fas fa-cart-plus text-sm"></i>
                </button>
            </div>
        `;
        productGrid.appendChild(card);
    });
}

// Add to Cart
window.addToCart = (product) => {
    if(product.stock_qty <= 0) {
        alert('Item is Out of Stock!');
        return;
    }

    const existing = cart.find(item => item.id === product.id);
    if (existing) {
        if(existing.qty < product.stock_qty) {
            existing.qty++;
        } else {
            alert('Cannot add more than available stock!');
        }
    } else {
        cart.unshift({ ...product, qty: 1 }); // Add to top
    }
    renderCart();
}

// Update Quantity
window.updateQty = (id, delta) => {
    const item = cart.find(i => i.id === id);
    if(item) {
        item.qty += delta;
        if(item.qty <= 0) {
            cart = cart.filter(i => i.id !== id);
        } else if (item.qty > item.stock_qty) {
            item.qty = item.stock_qty;
            alert('Cannot exceed available stock!');
        }
    }
    renderCart();
}

// Remove from Cart
window.removeFromCart = (id) => {
    cart = cart.filter(i => i.id !== id);
    renderCart();
}

// Render Cart
function renderCart() {
    cartItemsContainer.innerHTML = '';
    
    if (cart.length === 0) {
        cartItemsContainer.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-slate-500 opacity-60 space-y-4">
                <div class="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mb-2">
                    <i class="fas fa-shopping-basket text-4xl text-slate-600"></i>
                </div>
                <p class="font-medium text-slate-400">Your cart is empty</p>
                <p class="text-xs text-slate-500 text-center max-w-[200px]">Select items from the product grid to add them to your cart.</p>
            </div>
        `;
        subtotalEl.innerText = 'Rs. 0.00';
        taxEl.innerText = 'Rs. 0.00';
        totalEl.innerText = 'Rs. 0.00';
        return;
    }
    
    let subtotal = 0;
    cart.forEach(item => {
        const itemTotal = item.qty * item.retail_price;
        subtotal += itemTotal;
        
        const el = document.createElement('div');
        el.className = 'flex items-center p-3 bg-slate-800/40 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-colors group';
        el.innerHTML = `
            <div class="w-12 h-12 bg-slate-700 rounded-lg overflow-hidden mr-3 shrink-0">
                <img src="${item.image}" class="w-full h-full object-cover" alt="${item.name}">
            </div>
            <div class="flex-1 min-w-0 pr-2">
                <h4 class="font-medium text-slate-200 text-sm truncate">${item.name}</h4>
                <div class="text-primary font-medium text-xs mt-0.5">Rs. ${item.retail_price.toLocaleString()}</div>
            </div>
            <div class="flex flex-col items-end">
                <div class="flex items-center space-x-2 bg-dark rounded-lg p-1 border border-slate-700 mb-1">
                    <button onclick="updateQty(${item.id}, -1)" class="w-6 h-6 rounded flex items-center justify-center hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"><i class="fas fa-minus text-[10px]"></i></button>
                    <span class="w-5 text-center text-sm font-semibold text-white">${item.qty}</span>
                    <button onclick="updateQty(${item.id}, 1)" class="w-6 h-6 rounded flex items-center justify-center hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"><i class="fas fa-plus text-[10px]"></i></button>
                </div>
                <div class="text-sm font-bold text-slate-200">
                    Rs. ${itemTotal.toLocaleString()}
                </div>
            </div>
            <button onclick="removeFromCart(${item.id})" class="ml-3 text-slate-500 hover:text-accent opacity-0 group-hover:opacity-100 transition-opacity">
                <i class="fas fa-times"></i>
            </button>
        `;
        cartItemsContainer.appendChild(el);
    });
    
    // Calculate Totals
    const tax = subtotal * TAX_RATE;
    const total = subtotal + tax;
    
    subtotalEl.innerText = 'Rs. ' + subtotal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    taxEl.innerText = 'Rs. ' + tax.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    totalEl.innerText = 'Rs. ' + total.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

// Clear Cart
window.clearCart = () => {
    if(cart.length > 0 && confirm('Are you sure you want to clear the entire cart?')) {
        cart = [];
        renderCart();
    }
}

// Checkout
window.checkout = async () => {
    if(cart.length === 0) {
        alert('Cart is empty. Please add items before checking out.');
        return;
    }
    
    const confirmCheckout = confirm('Complete this transaction?');
    if(!confirmCheckout) return;

    try {
        const subtotal = cart.reduce((sum, item) => sum + (item.qty * item.retail_price), 0);
        const tax = subtotal * TAX_RATE;
        const total = subtotal + tax;
        
        // Save Sale
        const saleId = await db.sales.add({
            date: new Date().toISOString(),
            total_amount: total,
            payment_type: 'cash',
            status: 'completed',
            customer_id: 1 // default walk-in
        });
        
        // Save Sale Items & Update Stock
        const saleItems = [];
        for (const item of cart) {
            saleItems.push({
                sale_id: saleId,
                product_id: item.id,
                quantity: item.qty,
                unit_price: item.retail_price,
                line_total: item.qty * item.retail_price
            });
            
            // Deduct stock
            const p = await db.products.get(item.id);
            await db.products.update(item.id, { stock_qty: p.stock_qty - item.qty });
        }
        
        await db.sale_items.bulkAdd(saleItems);
        
        // Success notification
        alert(`Sale #${saleId} Completed Successfully!\nTotal: Rs. ${total.toLocaleString()}`);
        
        // Reset state
        cart = [];
        renderCart();
        loadProducts(); // refresh stock numbers
        
    } catch (error) {
        console.error('Checkout failed:', error);
        alert('An error occurred during checkout. Please try again.');
    }
}
