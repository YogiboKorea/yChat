require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { fetchProductsFromCafe24, getCachedProducts } = require('./services/cafe24Service');
const { connectDB } = require('./config/db');
const { getTokensFromDB } = require('./config/cafe24Api');

(async () => {
    try {
        await connectDB();
        await getTokensFromDB();
        await fetchProductsFromCafe24();
        const products = getCachedProducts();
        
        console.log("Total Products:", products.length);
        const maxProducts = products.filter(p => p.name.includes("맥스"));
        console.log("Max Products found:");
        maxProducts.forEach(p => console.log(`- ID: ${p.id}, Name: ${p.name}, URL: ${p.productUrl}`));

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
