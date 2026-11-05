"""Generates the three sample catalogs used for demos, manual testing and the answer-quality eval.

Run: python3 apps/api/src/scripts/gen-samples.py  (writes apps/api/src/data/samples/*.json)
Products are fictional. Images are placeholders.
"""
import json, os, random

random.seed(7)
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'samples')
os.makedirs(OUT, exist_ok=True)

def img(label):
    return f"https://placehold.co/400x400/1B2A4A/FFFFFF/png?text={label.replace(' ', '+')}"

def rating():
    return round(random.uniform(3.6, 4.9), 1), random.randint(8, 900)

# ---------------------------------------------------------------- wellness
wellness = []
proteins = [
    ("Whey Isolate", "whey", 25, False), ("Whey Blend", "whey", 22, True), ("Plant Protein", "pea and rice", 21, False),
    ("Soy Protein", "soy", 20, True), ("Casein Night Protein", "casein", 24, False), ("Collagen Peptides", "collagen", 18, False),
]
flavors = ["vanilla", "chocolate", "strawberry", "unflavored"]
brands = ["PeakForm", "GreenRoot", "IronLeaf"]
n = 1
for name, source, grams, soy in proteins:
    for fl in flavors:
        if source == "collagen" and fl == "strawberry":
            continue
        r, rc = rating()
        brand = "GreenRoot" if source in ("pea and rice",) else random.choice(brands)
        price = round(random.choice([29.99, 34.99, 39.99, 44.99, 54.99]) + (5 if source == "whey" and "Isolate" in name else 0), 2)
        desc = f"{name} powder with {grams}g of {source} protein per scoop. {fl.capitalize()} flavor, mixes smoothly in water or milk. "
        desc += "Contains soy lecithin. " if soy else "Soy-free and gluten-free. "
        desc += "Great after workouts." if source != "casein" else "Slow-release protein ideal before bed."
        wellness.append({
            "id": f"WEL-{n:03d}", "title": f"{brand} {name} - {fl.capitalize()}", "brand": brand,
            "description": desc, "categories": ["Protein Powder", "Supplements"], "tags": ["protein", "fitness", source.split()[0]],
            "price": price, "in_stock": random.random() > 0.1, "stock_qty": random.randint(0, 120),
            "rating": r, "review_count": rc, "image_url": img(f"{name} {fl}"), "url": f"https://demo-wellness.example/products/wel-{n:03d}",
            "attributes": {"flavor": fl, "protein_g": grams, "protein_source": source, "soy": "yes" if soy else "no", "size": random.choice(["1 lb", "2 lb", "5 lb"])},
        }); n += 1
others = [
    ("Shaker Bottle 28oz", "Accessories", ["protein", "fitness", "shaker"], 12.99, {"capacity": "28 oz", "color": "black"}, "Leak-proof shaker bottle with mixing ball. Dishwasher safe, BPA-free."),
    ("Stainless Shaker 24oz", "Accessories", ["protein", "fitness", "shaker"], 24.99, {"capacity": "24 oz", "color": "silver"}, "Insulated stainless steel shaker that keeps shakes cold for hours."),
    ("Pre-Workout Citrus Burst", "Pre-Workout", ["energy", "fitness"], 32.99, {"flavor": "citrus", "caffeine_mg": 200}, "Pre-workout with 200mg caffeine, beta-alanine and citrulline."),
    ("Stim-Free Pre-Workout Berry", "Pre-Workout", ["energy", "fitness"], 34.99, {"flavor": "berry", "caffeine_mg": 0}, "Caffeine-free pre-workout for evening training."),
    ("Daily Multivitamin", "Vitamins", ["vitamins", "health"], 19.99, {"servings": 60}, "Complete daily multivitamin with vitamin D3 and B12. Vegan."),
    ("Vitamin D3 + K2", "Vitamins", ["vitamins", "health"], 16.99, {"servings": 90}, "High-strength vitamin D3 with K2 for bone health."),
    ("Magnesium Glycinate Sleep", "Vitamins", ["vitamins", "sleep"], 21.99, {"servings": 60}, "Gentle magnesium for relaxation and better sleep."),
    ("Creatine Monohydrate", "Supplements", ["fitness", "strength"], 27.99, {"flavor": "unflavored", "servings": 100}, "Micronised creatine monohydrate, 5g per serving."),
    ("Resistance Band Set", "Equipment", ["fitness", "home workout"], 29.99, {"pieces": 5}, "Five latex-free resistance bands from light to extra heavy, with carry bag."),
    ("Eco Yoga Mat 6mm", "Equipment", ["yoga", "home workout"], 49.99, {"thickness_mm": 6, "color": "sage"}, "Non-slip natural rubber yoga mat, 6mm thick."),
    ("Foam Roller", "Equipment", ["recovery", "fitness"], 24.99, {"length_in": 18}, "High-density foam roller for muscle recovery."),
    ("Electrolyte Hydration Mix", "Supplements", ["hydration", "fitness"], 22.99, {"flavor": "lemon lime", "sugar_g": 0}, "Sugar-free electrolyte powder for training and travel."),
]
for title, cat, tags, price, attrs, desc in others:
    r, rc = rating()
    wellness.append({"id": f"WEL-{n:03d}", "title": title, "brand": random.choice(brands), "description": desc, "categories": [cat], "tags": tags,
                     "price": price, "in_stock": True, "stock_qty": random.randint(5, 200), "rating": r, "review_count": rc,
                     "image_url": img(title), "url": f"https://demo-wellness.example/products/wel-{n:03d}", "attributes": attrs}); n += 1

# ---------------------------------------------------------------- gifts
gifts = []
n = 1
gift_items = [
    ("Soy Wax Candle - Lavender Fields", "Candles", "lavender", "women", 28, "Hand-poured soy wax candle with lavender essential oil. 45-hour burn."),
    ("Soy Wax Candle - Cedar & Smoke", "Candles", "cedar", "men", 28, "Woody cedar and smoke scented candle in an amber glass jar."),
    ("Soy Wax Candle - Fresh Linen", "Candles", "linen", "anyone", 24, "Clean fresh-linen scent, perfect for any room."),
    ("Three Wick Candle - Vanilla Bean", "Candles", "vanilla", "anyone", 42, "Large three-wick candle with warm vanilla bean scent."),
    ("Personalized Name Mug", "Mugs", None, "anyone", 22, "Ceramic 11oz mug printed with a name of your choice."),
    ("Best Dad Ever Mug", "Mugs", None, "men", 18, "Classic 11oz ceramic mug for fathers. Dishwasher safe."),
    ("World's Best Mom Mug", "Mugs", None, "women", 18, "Classic 11oz ceramic mug for mothers. Dishwasher safe."),
    ("Sterling Silver Initial Necklace", "Jewelry", None, "women", 65, "Dainty sterling silver necklace with an engraved initial pendant."),
    ("Leather Bracelet for Men", "Jewelry", None, "men", 39, "Braided genuine leather bracelet with steel clasp."),
    ("Birthstone Stud Earrings", "Jewelry", None, "women", 49, "Hypoallergenic studs with a birthstone crystal of your choice."),
    ("Gourmet Chocolate Gift Box", "Food Gifts", None, "anyone", 35, "Assorted 16-piece Belgian chocolate box with gift ribbon."),
    ("Artisan Coffee Sampler", "Food Gifts", None, "anyone", 32, "Four single-origin coffees, 4oz each, whole bean."),
    ("Spa Day Gift Basket", "Gift Baskets", "lavender", "women", 79, "Bath bombs, body lotion, lavender candle and a plush towel."),
    ("BBQ Lover Gift Basket", "Gift Baskets", None, "men", 69, "Spice rubs, hot sauces and a stainless steel grill brush."),
    ("Kids Craft Kit", "Kids", None, "kids", 29, "Make-your-own bracelets and keychains kit for ages 6 and up."),
    ("Plush Dinosaur Bedtime Buddy", "Kids", None, "kids", 25, "Super-soft plush T-rex that glows softly at night."),
    ("Succulent Trio in Ceramic Pots", "Plants", None, "anyone", 36, "Three live succulents in white ceramic pots. Low maintenance."),
    ("Mini Bonsai Tree Kit", "Plants", None, "anyone", 45, "Grow-your-own bonsai kit with seeds, soil and guide."),
    ("Leather Journal", "Stationery", None, "anyone", 34, "Refillable leather-bound journal with 200 lined pages."),
    ("Engraved Wooden Watch Box", "Keepsakes", None, "men", 58, "Walnut watch box holding 6 watches, custom engraving included."),
    ("Photo Frame - Est. Year", "Keepsakes", None, "anyone", 27, "Wooden photo frame engraved with a family name and year."),
    ("Cozy Knit Throw Blanket", "Home", None, "anyone", 55, "Chunky knit throw blanket, 50 x 60 inches, machine washable."),
    ("Aromatherapy Diffuser", "Home", "lavender", "women", 39, "Ultrasonic diffuser with color-changing light, includes lavender oil."),
    ("Whiskey Stones Gift Set", "Bar", None, "men", 29, "Nine granite whiskey stones with two glasses in a wooden box."),
    ("Cocktail Shaker Set", "Bar", None, "anyone", 48, "Stainless steel 10-piece bartender kit with recipe card."),
    ("Anniversary Star Map Print", "Keepsakes", None, "couples", 59, "Custom star map of the night sky on your special date. 12x16 print."),
    ("Couples Bucket List Book", "Stationery", None, "couples", 21, "Fill-in book of 100 adventures to share."),
]
occasions = {"Candles": ["birthday", "thank you", "housewarming"], "Mugs": ["birthday", "fathers day", "mothers day"], "Jewelry": ["birthday", "anniversary", "valentines"],
             "Gift Baskets": ["birthday", "thank you", "get well"], "Kids": ["birthday", "holiday"], "Plants": ["housewarming", "thank you"],
             "Keepsakes": ["anniversary", "wedding", "fathers day"], "Bar": ["birthday", "fathers day"], "Food Gifts": ["thank you", "holiday"],
             "Stationery": ["graduation", "anniversary"], "Home": ["housewarming", "holiday"]}
for title, cat, scent, recipient, price, desc in gift_items:
    r, rc = rating()
    attrs = {"recipient": recipient, "occasion": ", ".join(occasions.get(cat, ["any"]))}
    if scent: attrs["scent"] = scent
    if "Personalized" in title or "Engraved" in title or "Custom" in desc or "engraved" in desc: attrs["personalized"] = "yes"
    gifts.append({"id": f"GFT-{n:03d}", "title": title, "brand": "Wrapped & Ready", "description": desc, "categories": [cat, "Gifts"],
                  "tags": ["gift", cat.lower()] + (["personalized"] if attrs.get("personalized") else []),
                  "price": price, "in_stock": random.random() > 0.08, "rating": r, "review_count": rc, "image_url": img(title),
                  "url": f"https://demo-gifts.example/products/gft-{n:03d}", "attributes": attrs}); n += 1

# ---------------------------------------------------------------- apparel
apparel = []
n = 1
shoes = [("Trail Runner X", "trail", 129), ("Road Glide 3", "road", 119), ("Daily Trainer", "road", 89), ("Summit Hiker Mid", "hiking", 149), ("Featherlight Racer", "road", 159)]
for name, terrain, price in shoes:
    for gender in ["women", "men"]:
        r, rc = rating()
        color = random.choice(["black", "navy", "grey", "red", "white"])
        wp = "yes" if terrain in ("trail", "hiking") and random.random() > 0.3 else "no"
        apparel.append({"id": f"APP-{n:03d}", "title": f"{name} {'Women' if gender == 'women' else 'Men'}'s Running Shoe" if terrain != "hiking" else f"{name} {'Women' if gender == 'women' else 'Men'}'s Hiking Boot",
                        "brand": "Northline", "description": f"{terrain.capitalize()} {'shoe' if terrain != 'hiking' else 'boot'} with cushioned midsole and grippy outsole. {'Waterproof membrane keeps feet dry.' if wp == 'yes' else 'Breathable mesh upper.'}",
                        "categories": ["Footwear", "Running" if terrain != "hiking" else "Hiking"], "tags": ["shoes", terrain, gender],
                        "price": price, "in_stock": random.random() > 0.1, "rating": r, "review_count": rc, "image_url": img(name),
                        "url": f"https://demo-apparel.example/products/app-{n:03d}",
                        "attributes": {"gender": gender, "terrain": terrain, "waterproof": wp, "color": color, "sizes": "5-11" if gender == "women" else "7-14"},
                        "variants": [{"size": s, "in_stock": random.random() > 0.2} for s in (range(5, 12) if gender == "women" else range(7, 15))]}); n += 1
tops = [("Merino Base Layer Tee", "Tops", 65, "merino wool"), ("Everyday Cotton Tee", "Tops", 25, "cotton"), ("Quick-Dry Running Tee", "Tops", 35, "polyester"),
        ("Fleece Hoodie", "Hoodies", 70, "fleece"), ("Organic Cotton Hoodie", "Hoodies", 80, "organic cotton"), ("Packable Rain Jacket", "Jackets", 120, "nylon"),
        ("Insulated Puffer Jacket", "Jackets", 180, "recycled polyester"), ("Running Shorts 5in", "Bottoms", 40, "polyester"), ("Jogger Pants", "Bottoms", 60, "cotton blend"),
        ("Cushioned Running Socks 3-Pack", "Socks", 18, "nylon blend"), ("Wool Hiking Socks", "Socks", 22, "merino wool")]
for title, cat, price, material in tops:
    for gender in (["women", "men"] if cat not in ("Socks",) else ["unisex"]):
        r, rc = rating()
        attrs = {"gender": gender, "material": material, "color": random.choice(["black", "navy", "olive", "heather grey", "sand"])}
        if cat == "Jackets": attrs["waterproof"] = "yes" if "Rain" in title else "no"
        apparel.append({"id": f"APP-{n:03d}", "title": f"{title}" + (f" - {gender.capitalize()}" if gender != "unisex" else ""), "brand": "Northline",
                        "description": f"{title} made from {material}. Comfortable fit for training and everyday wear.", "categories": [cat, "Clothing"],
                        "tags": ["clothing", cat.lower(), gender], "price": price, "in_stock": random.random() > 0.1, "rating": r, "review_count": rc,
                        "image_url": img(title), "url": f"https://demo-apparel.example/products/app-{n:03d}", "attributes": attrs}); n += 1

policies = {
    "wellness": {"shipping": "Free US shipping on orders over $50. Standard shipping takes 3 to 5 business days.", "returns": "Unopened products can be returned within 30 days for a full refund."},
    "gifts": {"shipping": "Orders ship within 1 business day. Free gift wrap on every order. US shipping is $6.95, free over $75.", "returns": "Non-personalized items can be returned within 30 days. Personalized items are final sale."},
    "apparel": {"shipping": "Free standard shipping in the US (4 to 6 business days). Express shipping is $15.", "returns": "Free returns and exchanges within 60 days, unworn with tags."},
}
meta = {
    "wellness": {"name": "PeakForm Nutrition (demo)", "description": "protein, supplements and home fitness gear"},
    "gifts": {"name": "Wrapped & Ready Gifts (demo)", "description": "thoughtful gifts for every occasion"},
    "apparel": {"name": "Northline Outdoor (demo)", "description": "running and outdoor apparel"},
}
for key, products in [("wellness", wellness), ("gifts", gifts), ("apparel", apparel)]:
    with open(os.path.join(OUT, f"{key}.json"), "w") as f:
        json.dump({"store": meta[key], "policies": policies[key], "products": products}, f, indent=1)
    print(key, len(products))
