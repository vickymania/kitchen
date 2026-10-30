package works.vexed.groceries

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Kotlin twin must answer as public/shared/suggest.js does: the same
 * examples as tests/suggest.test.mjs (30-10-2026).
 */
class SuggestTest {
    private val names = listOf(
        Suggest.Name("i1", "Minoes brokken", listOf("Pluizenbolbrokkenman"), "Minoes Brokken kip · 2 kg", 2.0),
        Suggest.Name("i2", "Minoes brood", emptyList(), null, 0.5),
        Suggest.Name("i3", "Uien", emptyList(), null, 1.0),
        Suggest.Name("i4", "Ui", emptyList(), null, 0.0),
        Suggest.Name("i5", "Jus d'orange", emptyList(), null, 0.0),
    )

    private fun top(text: String) = Suggest.suggest(names, text).map { "${it.name.name}:${it.tier}" }

    @Test fun prefixShowsBothMinoes() = assertEquals(listOf("Minoes brokken:2", "Minoes brood:2"), top("Mino"))
    @Test fun aliasPrefix() {
        val hit = Suggest.suggest(names, "Pluiz").single()
        assertEquals("Minoes brokken", hit.name.name)
        assertEquals("Pluizenbolbrokkenman", hit.via)
    }
    @Test fun spacesAndCase() {
        assertEquals("Minoes brokken:1", top("minoesbrokken").first())
        assertEquals("Minoes brokken:1", top("Minoesbrokken").first())
        assertEquals("Minoes brokken:0", top("MINOES BROKKEN").first())
        assertEquals("Minoes brokken:0", top("minoes-brokken").first())   // nameKey turns a hyphen into a space
    }
    @Test fun typos() {
        assertEquals("Minoes brokken:3", top("mines brokkken").first())
        assertEquals("Minoes brokken:3", top("minor brokken").first())
        assertEquals("Minoes brokken:3", top("brokkn").first())
    }
    @Test fun noNoise() {
        assertEquals(listOf("Minoes brood:0"), top("Minoes brood"))
        assertEquals(listOf("Ui:0", "Uien:2"), top("ui"))
        assertEquals(listOf("Jus d'orange:2"), top("jus"))
    }
    @Test fun namePartDropsTheAmount() = assertEquals("mino", Suggest.namePart("2 mino"))
    @Test fun nameKeyMatchesJs() = assertEquals("creme fraiche", Suggest.nameKey("Crème-fraîche (AH)"))
}
