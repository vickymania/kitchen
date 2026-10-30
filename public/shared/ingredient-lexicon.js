// English kitchen words -> the Dutch names a household would keep them under.
//
// Recipes keep the language they were written in (30-10-2026: an
// English "Soy Garlic Fried Chicken" linked 0 of 20 lines to Dutch items); only
// the MATCHING translates. The resolver (ingredient-match.js) asks this table
// as its LAST step, after the exact and Dutch steps, and runs every Dutch
// candidate through the same item lookup. Generic kitchen words only: no
// household data, no brands. Deliberately absent: anything the household's
// excluded filter handles, and typo-fuzzy guessing (a word is in the table or
// it is not). Values are candidates, most preferred first.
//
// A generic oil ("cooking oil", "vegetable oil") maps to "olie" only: it
// resolves when the household has an item "Olie" and stays unresolved
// otherwise; it is never forced onto "Zonnebloemolie".
// "water" is the same word in both languages and needs no entry.
import { nameKey } from "./ingredients.js";

const ENTRIES = {
  // meat, fish, dairy, eggs
  "chicken thigh": ["kipdijfilet", "kippendijen"], "chicken thighs": ["kipdijfilet", "kippendijen"],
  "chicken thigh fillet": ["kipdijfilet"], "chicken thigh fillets": ["kipdijfilet"],
  "chicken breast": ["kipfilet"], "chicken breasts": ["kipfilet"], "chicken breast fillet": ["kipfilet"],
  "chicken breast fillets": ["kipfilet"], "chicken fillet": ["kipfilet"], "chicken fillets": ["kipfilet"],
  "chicken": ["kip"], "minced beef": ["rundergehakt", "gehakt"], "ground beef": ["rundergehakt", "gehakt"],
  "minced meat": ["gehakt"], "ground meat": ["gehakt"], "ground pork": ["varkensgehakt", "gehakt"],
  "bacon": ["bacon", "spek"], "bacon strips": ["bacon", "spek"], "ham": ["ham"], "sausage": ["worst"], "sausages": ["worst", "worstjes"],
  "salmon": ["zalm"], "tuna": ["tonijn"], "shrimp": ["garnalen"], "shrimps": ["garnalen"], "prawns": ["garnalen"],
  "egg": ["eieren"], "eggs": ["eieren"], "egg yolk": ["eigeel"], "egg yolks": ["eigeel"],
  "egg white": ["eiwit"], "egg whites": ["eiwit"],
  "butter": ["boter", "roomboter"], "milk": ["melk"], "whole milk": ["volle melk", "melk"],
  "cream": ["room", "slagroom"], "heavy cream": ["slagroom", "room"], "whipping cream": ["slagroom"],
  "sour cream": ["zure room"], "yogurt": ["yoghurt"], "yoghurt": ["yoghurt"], "greek yogurt": ["griekse yoghurt", "yoghurt"],
  "cheese": ["kaas"], "grated cheese": ["geraspte kaas", "kaas"], "cream cheese": ["roomkaas"],
  "parmesan": ["parmezaanse kaas", "parmezaan"], "parmesan cheese": ["parmezaanse kaas", "parmezaan"],
  "mozzarella": ["mozzarella"], "feta": ["feta"],
  // vegetables, fruit
  "onion": ["ui", "uien"], "onions": ["uien", "ui"], "red onion": ["rode ui"], "red onions": ["rode ui"],
  "yellow onion": ["ui", "uien"], "white onion": ["ui", "uien"],
  "green onion": ["bosui", "lente ui"], "green onions": ["bosui", "lente ui"], "scallion": ["bosui", "lente ui"],
  "scallions": ["bosui", "lente ui"], "spring onion": ["bosui", "lente ui"], "spring onions": ["bosui", "lente ui"],
  "garlic": ["knoflook"], "garlic clove": ["knoflook"], "garlic cloves": ["knoflook"], "cloves garlic": ["knoflook"],
  "ginger": ["gember"], "fresh ginger": ["gember"],
  "tomato": ["tomaat", "tomaten"], "tomatoes": ["tomaten", "tomaat"], "cherry tomatoes": ["cherrytomaten", "tomaten"],
  "canned tomatoes": ["tomaten uit blik", "tomatenblokjes"], "tomato paste": ["tomatenpuree"], "tomato puree": ["tomatenpuree"],
  "potato": ["aardappel", "aardappelen"], "potatoes": ["aardappelen", "aardappel"], "sweet potato": ["zoete aardappel"],
  "sweet potatoes": ["zoete aardappel", "zoete aardappelen"], "carrot": ["wortel", "wortelen"], "carrots": ["wortelen", "wortel"],
  "bell pepper": ["paprika"], "bell peppers": ["paprika"], "red bell pepper": ["rode paprika", "paprika"],
  "cucumber": ["komkommer"], "lettuce": ["sla"], "spinach": ["spinazie"], "broccoli": ["broccoli"], "cauliflower": ["bloemkool"],
  "cabbage": ["kool"], "mushroom": ["champignons"], "mushrooms": ["champignons"], "zucchini": ["courgette"],
  "courgette": ["courgette"], "eggplant": ["aubergine"], "corn": ["mais"], "peas": ["erwten"],
  "green beans": ["sperziebonen"], "leek": ["prei"], "celery": ["selderij"],
  "lemon": ["citroen"], "lemons": ["citroenen", "citroen"], "lime": ["limoen"], "limes": ["limoenen", "limoen"],
  "apple": ["appel"], "apples": ["appels", "appel"], "banana": ["banaan"], "bananas": ["bananen", "banaan"],
  "avocado": ["avocado"], "avocados": ["avocados", "avocado"], "orange": ["sinaasappel"],
  "dried chili": ["gedroogde chilipeper"], "dried chilies": ["gedroogde chilipeper"],
  "dried chilli": ["gedroogde chilipeper"], "dried chillies": ["gedroogde chilipeper"],
  "dried chile": ["gedroogde chilipeper"], "dried chiles": ["gedroogde chilipeper"],
  "chili flakes": ["chilivlokken"], "chilli flakes": ["chilivlokken"], "red pepper flakes": ["chilivlokken"],
  "crushed red pepper": ["chilivlokken"], "chili": ["chilipeper"], "chilies": ["chilipeper"], "chilli": ["chilipeper"],
  "chillies": ["chilipeper"], "chili pepper": ["chilipeper"], "red chili": ["rode peper", "chilipeper"],
  // pantry, baking
  "flour": ["bloem"], "all purpose flour": ["bloem"], "plain flour": ["bloem"], "wheat flour": ["bloem"],
  "corn starch": ["maizena"], "cornstarch": ["maizena"], "corn flour": ["maizena"], "potato starch": ["aardappelzetmeel"],
  "sugar": ["suiker"], "white sugar": ["suiker", "kristalsuiker"], "granulated sugar": ["suiker", "kristalsuiker"],
  "brown sugar": ["basterdsuiker", "bruine suiker"], "light brown sugar": ["basterdsuiker", "bruine suiker"],
  "dark brown sugar": ["basterdsuiker", "donkere basterdsuiker", "bruine suiker"],
  "powdered sugar": ["poedersuiker"], "icing sugar": ["poedersuiker"], "honey": ["honing"],
  "maple syrup": ["ahornsiroop"], "baking powder": ["bakpoeder"], "baking soda": ["zuiveringszout", "baking soda"],
  "yeast": ["gist"], "vanilla extract": ["vanille extract", "vanille"], "cocoa powder": ["cacaopoeder"],
  "rice": ["rijst"], "white rice": ["rijst"], "noodles": ["noedels"], "bread": ["brood"], "breadcrumbs": ["paneermeel"],
  "bread crumbs": ["paneermeel"], "panko": ["paneermeel"], "oats": ["havermout"], "rolled oats": ["havermout"],
  "lentils": ["linzen"], "chickpeas": ["kikkererwten"], "kidney beans": ["kidneybonen"], "black beans": ["zwarte bonen"],
  "peanut butter": ["pindakaas"], "peanuts": ["pinda's", "pindas"], "almonds": ["amandelen"], "walnuts": ["walnoten"],
  "sesame seeds": ["sesamzaad"], "sesame seed": ["sesamzaad"],
  "sesame oil": ["sesamolie"], "coconut milk": ["kokosmelk"],
  // oils and sauces
  "oil": ["olie"], "cooking oil": ["olie"], "vegetable oil": ["olie"], "neutral oil": ["olie"],
  "olive oil": ["olijfolie"], "extra virgin olive oil": ["olijfolie"], "sunflower oil": ["zonnebloemolie"],
  "soy sauce": ["sojasaus"], "light soy sauce": ["sojasaus"], "dark soy sauce": ["sojasaus"], "fish sauce": ["vissaus"],
  "oyster sauce": ["oestersaus"], "hot sauce": ["hete saus", "sriracha"], "ketchup": ["ketchup"], "mayonnaise": ["mayonaise"],
  "mayo": ["mayonaise"], "mustard": ["mosterd"], "vinegar": ["azijn"], "white vinegar": ["azijn"],
  "rice vinegar": ["rijstazijn", "azijn"],
  "chicken stock": ["kippenbouillon"], "chicken broth": ["kippenbouillon"], "vegetable stock": ["groentebouillon"],
  "vegetable broth": ["groentebouillon"], "beef stock": ["runderbouillon"], "beef broth": ["runderbouillon"],
  // salt, spices, herbs
  "salt": ["zout"], "sea salt": ["zout", "zeezout"], "kosher salt": ["zout"], "table salt": ["zout"],
  "pepper": ["peper"], "black pepper": ["zwarte peper", "peper"], "ground black pepper": ["zwarte peper", "peper"],
  "white pepper": ["witte peper", "peper"],
  "onion powder": ["uienpoeder"], "garlic powder": ["knoflookpoeder"],
  "ginger powder": ["gember gemalen", "gemberpoeder", "gember"], "ground ginger": ["gember gemalen", "gemberpoeder", "gember"],
  "paprika powder": ["paprikapoeder"], "smoked paprika": ["gerookt paprikapoeder", "paprikapoeder"],
  "cumin": ["komijn"], "ground cumin": ["komijn"], "cinnamon": ["kaneel"], "ground cinnamon": ["kaneel"],
  "turmeric": ["kurkuma"], "nutmeg": ["nootmuskaat"], "oregano": ["oregano"], "thyme": ["tijm"], "basil": ["basilicum"],
  "parsley": ["peterselie"], "cilantro": ["koriander"], "coriander": ["koriander"], "mint": ["munt"], "rosemary": ["rozemarijn"],
  "bay leaf": ["laurier"], "bay leaves": ["laurier"], "curry powder": ["kerrie", "currypoeder"],
};

const TABLE = new Map(Object.entries(ENTRIES).map(([en, nl]) => [nameKey(en), nl.map(nameKey)]));

/** How many English names the table knows (a guard for the tests). */
export const LEXICON_SIZE = TABLE.size;

/**
 * The Dutch candidate names for an English ingredient name (anything nameKey
 * takes), most preferred first; [] when the table does not know it. Also tries
 * the last word singular or plural.
 */
export function dutchNames(name) {
  const key = nameKey(name);
  if (!key) return [];
  const direct = TABLE.get(key);
  if (direct) return direct;
  const words = key.split(" ");
  const last = words.at(-1);
  const forms = [];
  if (last.endsWith("ies")) forms.push(`${last.slice(0, -3)}y`);
  if (last.endsWith("oes")) forms.push(last.slice(0, -2));
  if (last.endsWith("s") && !last.endsWith("ss")) forms.push(last.slice(0, -1));
  else forms.push(`${last}s`);
  for (const form of forms) {
    const hit = TABLE.get([...words.slice(0, -1), form].join(" "));
    if (hit) return hit;
  }
  return [];
}
