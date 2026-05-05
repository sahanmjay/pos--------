// Initialize Dexie Database
const db = new Dexie("NexPOSDatabase");

db.version(1).stores({
    products: '++id, name, sku, barcode, type, retail_price, stock_qty, category',
    customers: '++id, name, phone, email',
    sales: '++id, date, total_amount, payment_type, status, customer_id',
    sale_items: '++id, sale_id, product_id, quantity, unit_price, line_total',
    categories: '++id, name'
});

// Seed data if empty
async function seedDatabase() {
    const productCount = await db.products.count();
    
    if (productCount === 0) {
        console.log("Seeding Database...");
        
        // Seed Categories
        await db.categories.bulkAdd([
            { name: 'Clothing' },
            { name: 'Footwear' },
            { name: 'Accessories' }
        ]);

        // Seed Products with Dummy Data from Unsplash
        await db.products.bulkAdd([
            { name: 'Classic T-Shirt', sku: 'TS-BLK-M', barcode: '10001', type: 'retail', retail_price: 2500, stock_qty: 45, category: 'Clothing', image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=300&h=300&fit=crop' },
            { name: 'Denim Jeans', sku: 'JN-BLU-32', barcode: '10002', type: 'retail', retail_price: 5500, stock_qty: 20, category: 'Clothing', image: 'https://images.unsplash.com/photo-1542272604-787c3835535d?w=300&h=300&fit=crop' },
            { name: 'Sport Sneakers', sku: 'SNK-WHT-42', barcode: '10003', type: 'retail', retail_price: 12000, stock_qty: 12, category: 'Footwear', image: 'https://images.unsplash.com/photo-1549298916-b41d501d3772?w=300&h=300&fit=crop' },
            { name: 'Urban Backpack', sku: 'BP-GRY', barcode: '10004', type: 'retail', retail_price: 6500, stock_qty: 18, category: 'Accessories', image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=300&h=300&fit=crop' },
            { name: 'Luxury Watch', sku: 'WT-GLD', barcode: '10005', type: 'retail', retail_price: 24000, stock_qty: 5, category: 'Accessories', image: 'https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=300&h=300&fit=crop' },
            { name: 'Baseball Cap', sku: 'CP-BLK', barcode: '10006', type: 'retail', retail_price: 1500, stock_qty: 35, category: 'Accessories', image: 'https://images.unsplash.com/photo-1588850561407-ed78c282e89b?w=300&h=300&fit=crop' },
            { name: 'Leather Wallet', sku: 'WL-BRN', barcode: '10007', type: 'retail', retail_price: 3200, stock_qty: 25, category: 'Accessories', image: 'https://images.unsplash.com/photo-1627123424574-724758594e93?w=300&h=300&fit=crop' },
            { name: 'Running Shoes', sku: 'SNK-BLK-40', barcode: '10008', type: 'retail', retail_price: 14500, stock_qty: 8, category: 'Footwear', image: 'https://images.unsplash.com/photo-1608231387042-66d1773070a5?w=300&h=300&fit=crop' },
        ]);

        // Seed Customers
        const customerCount = await db.customers.count();
        if(customerCount === 0){
            await db.customers.add({ name: 'Walk-in Customer', phone: '000000000', email: '' });
        }
    }
}

// Call seed on load
seedDatabase();
