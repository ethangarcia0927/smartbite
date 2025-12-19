import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import session from 'express-session';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();

// API configuration from environment variables
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const SPOONACULAR_BASE_URL = 'https://spoonacular-recipe-food-nutrition-v1.p.rapidapi.com';

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

//Session settings
app.set('trust proxy', 1);  
app.use(session({ 
    secret: process.env.SESSION_SECRET || 'keyboard cat', 
    resave: false, 
    saveUninitialized: true 
}))

// === MySQL connection pool ===
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

// === Routes ===

// Home page
app.get('/', async (req, res) => {


    try {
        const [recipes] = await pool.query("SELECT * FROM recipes ORDER BY title");

        // Get distinct health goals for dropdown
        const [healthGoals] = await pool.query("SELECT DISTINCT health_goal FROM fp_recipes");

        res.render('index', { recipes,
            "healthGoals" : healthGoals
         }); // pass recipes to home page
    } catch (err) {
        console.error("DB error:", err);
        res.status(500).send("Database error");
    }

    // Get distinct health goals for dropdown
        // const [healthGoals] = await pool.query("SELECT DISTINCT health_goal FROM fp_recipes");
        // res.render('index', { 
        //     "healthGoals" : healthGoals
        //  });

 });

// Combined Search Route - handles both community and web search
app.get('/search', async (req, res) => {
    try {
        const { keyword, cuisine, mealType, diet, priceRange, cookTime, communitySearch, webSearch } = req.query;
        
        let communityResults = [];
        let webResults = [];
        let isFavorited = {};
        const user_id = req.session.user_id || null;

        // If logged in, get their favorites
        if (user_id) {
            const [favorites] = await pool.query(
                'SELECT recipe_id FROM favorites WHERE user_id = ?',
                [user_id]
            );
            favorites.forEach(fav => {
                isFavorited[fav.recipe_id] = true;
            });
        }

        // Community Search (Local Database)
        if (communitySearch === 'on') {
            let sql = "SELECT * FROM fp_recipes WHERE source = 'community'";
            let sqlParams = [];

            // Add keyword filter
            if (keyword && keyword.trim() !== '') {
                sql += ' AND (title LIKE ? OR ingredients LIKE ?)';
                sqlParams.push(`%${keyword}%`, `%${keyword}%`);
            }

            // Add cuisine filter
            if (cuisine && cuisine !== '') {
                sql += ' AND cuisine = ?';
                sqlParams.push(cuisine);
            }

            // Add meal type filter
            if (mealType && mealType !== '') {
                sql += ' AND meal_type = ?';
                sqlParams.push(mealType);
            }

            // Add diet filter
            if (diet && diet !== '') {
                sql += ' AND diet = ?';
                sqlParams.push(diet);
            }

            // Add price range filter
            if (priceRange && priceRange !== '') {
                const [minPrice, maxPrice] = priceRange.split('-').map(parseFloat);
                sql += ' AND price >= ? AND price <= ?';
                sqlParams.push(minPrice, maxPrice);
            }

            // Add cook time filter
            if (cookTime && cookTime !== '') {
                const time = parseInt(cookTime);
                if (time === 10) {
                    sql += ' AND cook_time < ?';
                    sqlParams.push(10);
                } else if (time === 61) {
                    sql += ' AND cook_time >= ?';
                    sqlParams.push(60);
                } else if (time === 60) {
                    sql += ' AND cook_time >= ? AND cook_time < ?';
                    sqlParams.push(30, 60);
                } else {
                    sql += ' AND cook_time >= ? AND cook_time < ?';
                    sqlParams.push(time - 10, time);
                }
            }

            const [rows] = await pool.query(sql, sqlParams);
            communityResults = rows.map(recipe => ({
                ...recipe,
                source: 'community'
            }));
        }

        // Web Search (Spoonacular API via RapidAPI)
        if (webSearch === 'on') {
            const params = new URLSearchParams({
                number: 12,
                addRecipeInformation: true,
                fillIngredients: false
            });

            if (keyword && keyword.trim() !== '') params.append('query', keyword.trim());
            if (cuisine && cuisine !== '') params.append('cuisine', cuisine);
            if (diet && diet !== '') {
                // Map local diet names to Spoonacular diet names
                const dietMap = {
                    'Vegetarian': 'Vegetarian',
                    'Vegan': 'Vegan',
                    'Gluten-Free': 'Gluten Free',
                    'Keto': 'Ketogenic',
                    'Pescatarian': 'Pescetarian'
                };
                params.append('diet', dietMap[diet] || diet);
            }
            if (mealType && mealType !== '') {
                // Map meal types to Spoonacular types
                const typeMap = {
                    'Breakfast': 'breakfast',
                    'Lunch': 'main course',
                    'Dinner': 'main course',
                    'Snack': 'snack',
                    'Dessert': 'dessert'
                };
                params.append('type', typeMap[mealType] || mealType.toLowerCase());
            }
            
            // Handle cook time for API (use as maxReadyTime)
            if (cookTime && cookTime !== '') {
                const time = parseInt(cookTime);
                if (time === 10) params.append('maxReadyTime', 10);
                else if (time === 20) params.append('maxReadyTime', 20);
                else if (time === 30) params.append('maxReadyTime', 30);
                else if (time === 60) params.append('maxReadyTime', 60);
                else if (time === 61) params.append('minReadyTime', 60);
            }

            // Handle price range for API (in cents per serving)
            if (priceRange && priceRange !== '') {
                const [minPrice, maxPrice] = priceRange.split('-').map(parseFloat);
                params.append('minPrice', Math.floor(minPrice * 100));
                params.append('maxPrice', Math.floor(maxPrice * 100));
            }

            try {
                const fetchOptions = {
                    method: 'GET',
                    headers: {
                        'x-rapidapi-key': RAPIDAPI_KEY,
                        'x-rapidapi-host': 'spoonacular-recipe-food-nutrition-v1.p.rapidapi.com'
                    }
                };

                const response = await fetch(`${SPOONACULAR_BASE_URL}/recipes/complexSearch?${params}`, fetchOptions);
                const data = await response.json();
                
                console.log('Spoonacular API response status:', response.status);
                if (data.status === 'failure') {
                    console.error('Spoonacular API error:', data.message);
                }
                
                // Fetch nutrition (fat, carbs, protein) for each recipe
                const recipesWithNutrition = await Promise.all(
                    (data.results || []).map(async (recipe) => {
                        let fat = 0, carb = 0, protein = 0;
                        
                        try {
                            const nutritionUrl = `${SPOONACULAR_BASE_URL}/recipes/${recipe.id}/nutritionWidget.json`;
                            const nutritionResponse = await fetch(nutritionUrl, fetchOptions);
                            const nutritionData = await nutritionResponse.json();
                            
                            fat = parseInt(nutritionData.fat?.replace('g', '') || 0);
                            carb = parseInt(nutritionData.carbs?.replace('g', '') || 0);
                            protein = parseInt(nutritionData.protein?.replace('g', '') || 0);
                        } catch (nutritionError) {
                            console.error(`Error fetching nutrition for recipe ${recipe.id}:`, nutritionError);
                        }
                        
                        return {
                            recipe_id: recipe.id,
                            title: recipe.title,
                            img_url: recipe.image,
                            cuisine: cuisine || 'Various',
                            meal_type: mealType || 'Various',
                            diet: diet || 'Various',
                            cook_time: recipe.readyInMinutes || 0,
                            price: recipe.pricePerServing ? (recipe.pricePerServing / 100).toFixed(2) : 0,
                            fat: fat,
                            carb: carb,
                            protein: protein,
                            source: 'web',
                            sourceUrl: recipe.sourceUrl,
                            servings: recipe.servings
                        };
                    })
                );
                
                webResults = recipesWithNutrition;
            } catch (apiError) {
                console.error("Spoonacular API error:", apiError);
                // Continue without web results if API fails
            }
        }

        // Combine results
        const allResults = [...communityResults, ...webResults];

        res.render("results", {
            recipes: allResults,
            searchParams: req.query,
            user_id: user_id,
            isFavorited: isFavorited
        });

    } catch (error) {
        console.error("Search error:", error);
        res.status(500).send("Error performing search");
    }
});

 //keyword search -Aohua
 app.get('/searchByKeyword', async (req, res) => {
    let userKeyword = req.query.keyword;
    let sql = `SELECT *
                From fp_recipes
                WHERE title LIKE ? OR ingredients LIKE ?`;
    let sqlParams = [`%${userKeyword}%`, `%${userKeyword}%`];
    const [rows] = await pool.query(sql, sqlParams);

    res.render("results", 
        { 
            "recipes": rows 
        });

});

// Search by Cuisine
app.get('/searchByCuisine', async (req, res) => {
    let cuisine = req.query.cuisine;
    let sql = `SELECT * FROM fp_recipes WHERE cuisine = ?`;
    const [rows] = await pool.query(sql, [cuisine]);
    res.render("results", { recipes: rows });
});

// Search by Meal Type
app.get('/searchByMealType', async (req, res) => {
    let mealType = req.query.mealType;
    let sql = `SELECT * FROM fp_recipes WHERE meal_type = ?`;
    const [rows] = await pool.query(sql, [mealType]);
    res.render("results", { recipes: rows });
});

// Search by Diet
app.get('/searchByDiet', async (req, res) => {
    let diet = req.query.diet;
    let sql = `SELECT * FROM fp_recipes WHERE diet = ?`;
    const [rows] = await pool.query(sql, [diet]);
    res.render("results", { recipes: rows });
});

// Search by Price Range
app.get('/searchByPrice', async (req, res) => {
    let priceRange = req.query.priceRange;
    let [minPrice, maxPrice] = priceRange.split('-').map(parseFloat);
    let sql = `SELECT * FROM fp_recipes WHERE price >= ? AND price <= ?`;
    const [rows] = await pool.query(sql, [minPrice, maxPrice]);
    res.render("results", { recipes: rows });
});

// Search by Cook Time
app.get('/searchByTime', async (req, res) => {
    let time = parseInt(req.query.cookTime);
    let sql;
    let sqlParams;

    if (time === 10) {
        // Under 10 min
        sql = `SELECT * FROM fp_recipes WHERE cook_time < ?`;
        sqlParams = [10];
    } else if (time === 61) {
        // 1hr and more
        sql = `SELECT * FROM fp_recipes WHERE cook_time >= ?`;
        sqlParams = [60];
    } else if (time === 60) {
        // 30-60
        sql = `SELECT * FROM fp_recipes WHERE cook_time >= ? AND cook_time < ?`;
        sqlParams = [time - 30, time];
    } else {
        // Between ranges (10-20, 20-30, 30-60)
        sql = `SELECT * FROM fp_recipes WHERE cook_time >= ? AND cook_time < ?`;
        sqlParams = [time - 10, time];
    }

    const [rows] = await pool.query(sql, sqlParams);
    res.render("results", { recipes: rows });
});

//Recipes page
app.get("/recipes", async(req, res) => {

    const [recipes] = await pool.query("SELECT * FROM fp_recipes WHERE source = 'community' OR source IS NULL ORDER BY title");

    res.render("recipeList", { 
            recipes: recipes
        });
});

//Add recipe page, display adding form
app.get("/addRecipe", (req, res) => {
    res.render("newRecipe",
        { message: req.query.message }
    );
});

//Add Recipie, form submission
app.post("/addRecipe", async (req, res) => {
    try {
        const { 
            title,
            cuisine,
            meal_type,
            diet,
            budget_level,
            price,
            cook_time, 
            health_goal, 
            img_url, 
            fat, 
            carb, 
            protein, 
            ingredients, 
            instructions 
        } = req.body;

        // Validate required fields
        if (!title || !cuisine || !meal_type || !diet || !budget_level || !price || !cook_time || !health_goal || !ingredients || !instructions) {
            return res.redirect("/addRecipe?message=Please+fill+in+all+required+fields");
        }

        // Set default image if not provided
        const imageUrl = img_url || "img/default_recipe.jpg";

        const sql = `INSERT INTO fp_recipes 
            (title, cuisine, meal_type, diet, budget_level, price, cook_time, health_goal, img_url, fat, carb, protein, ingredients, instructions, source) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        await pool.query(sql, [
            title,
            cuisine,
            meal_type,
            diet,
            budget_level,
            parseFloat(price) || 0,
            parseInt(cook_time),
            health_goal,
            imageUrl,
            parseInt(fat) || 0,
            parseInt(carb) || 0,
            parseInt(protein) || 0,
            ingredients,
            instructions,
            'community'
        ]);

        res.redirect("/recipes?message=Recipe+added+successfully!");
    } catch (err) {
        console.error("DB error:", err);
        res.redirect("/addRecipe?message=Error+adding+recipe.+Please+try+again.");
    }
});

//Local API: get budget levels
app.get('/api/budgetLevels', async (req, res) => {
    const [rows] = await pool.query("SELECT DISTINCT budget_level FROM fp_recipes");
        res.json(rows);
});

//Local API: get health goals
app.get('/api/healthGoals', async (req, res) => {
    const [rows] = await pool.query("SELECT DISTINCT health_goal FROM fp_recipes");
    res.json(rows);
});


// Test database connection
app.get('/dbTest', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT CURDATE() AS today");
        res.send(rows);
    } catch (err) {
        console.error("Database error:", err);
        res.status(500).send("Database error");
    }
});

// Login page, can make Home page require login later if needed!
app.get('/login', (req, res) => {
    res.render('login', {message: req.query.message});
});

app.post('/login', async(req, res) => {
    let email = req.body.email;
    let password = req.body.password;
    if (!email || !password) {
        return res.redirect("/login?message=Incorrect+email+or+password!");
    }

    // let passwordHash = "$2a$10$06ofFgXJ9wysAOzQh0D0..RcDp1w/urY3qhO6VuUJL2c6tzAJPfj6";
    // test user: test@user.com, pw = secret, admin/secret added 12/13
    let sql = `SELECT * FROM users WHERE email = ?`;
    const [rows] = await pool.query(sql,[email]);
    if (rows.length === 0) {
        console.log("No user found!");
        return res.redirect("/login?message=No+user+found!");
    }
    let passwordHash = rows[0].password_hash;
    let match = await bcrypt.compare(password, passwordHash);

    if (match) {
        req.session.authenticated = true;
        req.session.user_id = rows[0].user_id;
        req.session.email = rows[0].email;
        // res.render("/profile") //place holder till profile page made below
        res.redirect("/myProfile");
    } else {
        return res.redirect("/login?message=Incorrect+email+or+password!");
    }
});

//Render profile if authenticated
app.get('/myProfile', isAuthenticated, async (req, res) => {
    const userId = req.session.user_id;
    let sql = `SELECT name, email, diet_goal, budget_level FROM users WHERE user_id = ?`;
    const[rows] = await pool.query(sql, [userId]);
    res.render("profile", {user: rows[0]});
});

//Adding update profile feature
app.post("/myProfile", isAuthenticated, async (req, res) => {
  const userId = req.session.user_id;
  const {name, diet_goal, budget_level} = req.body;
  let sql = `UPDATE users SET name = ?, diet_goal = ?, budget_level = ? WHERE user_id = ?`;
  const[rows] = await pool.query(sql, [name || null, diet_goal || null, budget_level || null, userId]);
  
  res.redirect("/myProfile");
});


//Authentication function for login
function isAuthenticated(req,res,next) {
    if (!req.session.authenticated || !req.session.user_id) {
        return res.redirect("/login?message=Please+log+in.");
    } else {
        next();
    }
}

//Logout route
app.get('/logout', isAuthenticated, (req,res) => {
    req.session.destroy();
    res.redirect("/");
});

//Register User
app.get("/register", (req, res) => {
    res.render("register", {message: req.query.message});
});

app.post("/register", async (req , res) => {
    const {name, email, password, diet_goal, budget_level} = req.body;
    if (!email || !password) {
        return res.redirect("/register?message=Email+and+password+required");
    }
    if (password.length < 6) {
      return res.redirect("/register?message=Password+must+be+six+characters+minimum.");
    }

    let checkExistingSql = `SELECT user_id FROM users WHERE email = ?`;
    const [rows] = await pool.query(checkExistingSql,[email]);
    if (rows.length > 0) {
        return res.redirect("/register?message=Email+already+registered");
    }

    let password_hash = await bcrypt.hash(password, 10);
    let userSql = `INSERT INTO users (name, email, password_hash, diet_goal, budget_level) VALUES (?, ?, ?, ?, ?)`;
    const[userRows] = await pool.query(userSql, [name || null, email, password_hash, diet_goal || null, budget_level || null]);

    req.session.authenticated = true;
    req.session.email = email;

    req.session.user_id = userRows.insertId; //?

    return res.redirect("/myProfile");

});


// Favorites API - Ethan
// Add recipe to favorites
app.post('/api/favorites', isAuthenticated, async (req, res) => {
    const user_id = req.session.user_id;
    const recipe_id = req.body.recipe_id;

    const sql = `INSERT INTO favorites (user_id, recipe_id, created_at)
    VALUES (? , ?, NOW())`;
    await pool.query(sql, [user_id, recipe_id]);
    res.redirect(`/recipe/${recipe_id}`);
});

// Remove from favorites
app.get("/api/favorites/delete", isAuthenticated, async (req,res) => {
    const user_id = req.session.user_id;
    const { recipe_id } = req.query;
    let sql = `DELETE FROM favorites WHERE user_id = ? AND recipe_id = ?`;
    await pool.query(sql, [user_id, recipe_id]);
    res.redirect("/favorites");
});

app.post('/api/favorites/toggle', isAuthenticated, async (req, res) => {
    try {
        const user_id = req.session.user_id;
        const { recipe_id, source, recipe_data } = req.body;

        // Web recipes
        if (source === 'web' && recipe_data) {
            // is it already in fp_recipes
            const [existing] = await pool.query(
                'SELECT recipe_id FROM fp_recipes WHERE title = ? AND cuisine = ?',
                [recipe_data.title, recipe_data.cuisine]
            );

            let dbRecipeId;
            if (existing.length === 0) {
                const insertSql = `INSERT INTO fp_recipes 
                    (title, cuisine, meal_type, diet, budget_level, price, cook_time, health_goal, img_url, fat, carb, protein, ingredients, instructions, source) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
                
                const [result] = await pool.query(insertSql, [
                    recipe_data.title,
                    recipe_data.cuisine,
                    recipe_data.meal_type,
                    recipe_data.diet,
                    'Regular',
                    parseFloat(recipe_data.price) || 0,
                    parseInt(recipe_data.cook_time) || 0,
                    'None', // health_goal
                    recipe_data.img_url,
                    parseInt(recipe_data.fat) || 0,
                    parseInt(recipe_data.carb) || 0,
                    parseInt(recipe_data.protein) || 0,
                    'See source URL for ingredients',
                    'See source URL for instructions',
                    'web' // source
                ]);
                dbRecipeId = result.insertId;
            } else {
                dbRecipeId = existing[0].recipe_id;
            }

            const [checkFavorite] = await pool.query(
                'SELECT id FROM favorites WHERE user_id = ? AND recipe_id = ?',
                [user_id, dbRecipeId]
            );

            if (checkFavorite.length > 0) {
                // Remove
                await pool.query(
                    'DELETE FROM favorites WHERE user_id = ? AND recipe_id = ?',
                    [user_id, dbRecipeId]
                );
                
                // See if other users favorited it
                const [otherFavorites] = await pool.query(
                    'SELECT id FROM favorites WHERE recipe_id = ?',
                    [dbRecipeId]
                );
                
                // If no other user favorited it then we can delete it
                if (otherFavorites.length === 0) {
                    await pool.query(
                        'DELETE FROM fp_recipes WHERE recipe_id = ? AND source = ?',
                        [dbRecipeId, 'web']
                    );
                }
                
                res.json({ success: true, action: 'removed' });
            } else {
                // Add
                await pool.query(
                    'INSERT INTO favorites (user_id, recipe_id, created_at) VALUES (?, ?, NOW())',
                    [user_id, dbRecipeId]
                );
                res.json({ success: true, action: 'added' });
            }
        } else {
            // Community recipes
            const [checkFavorite] = await pool.query(
                'SELECT id FROM favorites WHERE user_id = ? AND recipe_id = ?',
                [user_id, recipe_id]
            );

            if (checkFavorite.length > 0) {
                // Remove
                await pool.query(
                    'DELETE FROM favorites WHERE user_id = ? AND recipe_id = ?',
                    [user_id, recipe_id]
                );
                res.json({ success: true, action: 'removed' });
            } else {
                // Add
                await pool.query(
                    'INSERT INTO favorites (user_id, recipe_id, created_at) VALUES (?, ?, NOW())',
                    [user_id, recipe_id]
                );
                res.json({ success: true, action: 'added' });
            }
        }
    } catch (error) {
        console.error('Error toggling favorite:', error);
        res.status(500).json({ success: false, error: 'Failed to toggle favorite' });
    }
});

// Show favorites page
app.get("/favorites", isAuthenticated, async (req, res) => {
    const user_id = req.session.user_id;

    const sql = `
        SELECT r.recipe_id, r.title, r.cuisine, r.meal_type, r.diet, r.price, r.cook_time, 
               r.img_url, r.fat, r.carb, r.protein, r.ingredients, r.instructions, r.source
        FROM favorites f
        JOIN fp_recipes r on f.recipe_id = r.recipe_id
        WHERE f.user_id = ?
        ORDER BY f.created_at DESC
        `;

        const [favorites] = await pool.query(sql, [user_id]);
        res.render("favorites", { favorites });
});

// Recipe Details Page
app.get("/recipe/:id", async (req, res) => {
    const recipeId = req.params.id;
    const sql = `SELECT * FROM recipes WHERE recipe_id = ?`;
    const [rows] = await pool.query(sql, [recipeId]);

    res.render("recipeDetails", { recipe: rows[0] });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SmartBite server running on port ${PORT}`);
});
