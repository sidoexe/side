import Foundation

/// As the desktop's `monoReaction`: a Colleague can answer with only an emoji
/// on the user's message, by making its whole reply `<reaction>👍</reaction>`.
/// The chat hides that reply and pins the emoji to the message it answers.
enum MonoReaction {
    private static let open = "<reaction>"
    private static let close = "</reaction>"

    /// The emoji when a reply is only a reaction.
    static func emoji(_ text: String) -> String? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(open), text.hasSuffix(close) else { return nil }
        let inner = text.dropFirst(open.count).dropLast(close.count).trimmingCharacters(in: .whitespacesAndNewlines)
        return isSingleEmoji(inner) ? inner : nil
    }

    /// One emoji, as `isSingleEmoji`: a flag, a keycap or one picture.
    private static func isSingleEmoji(_ text: String) -> Bool {
        guard text.count == 1, let first = text.unicodeScalars.first else { return false }
        return first.properties.isEmojiPresentation
            || (first.properties.isEmoji && text.unicodeScalars.count > 1)
    }

    /// A reply still streaming in that may yet turn out to be a reaction.
    private static func partial(_ block: Block) -> Bool {
        guard block.streaming == true else { return false }
        let text = String(block.text.drop { $0.isWhitespace })
        return text.count < open.count ? open.hasPrefix(text) : text.hasPrefix(open) && !text.contains("</")
    }

    /// As `monoReactionBlocks`: the chat's blocks with each reaction moved
    /// onto the user's message before it. One with no message to sit on
    /// shows as the emoji on its own.
    static func blocks(_ blocks: [Block]) -> [Block] {
        var out: [Block] = []
        var target: Int?
        for block in blocks {
            if block.role == "user" {
                if block.internal != true { target = out.count }
                out.append(block)
                continue
            }
            if block.role != "assistant" || block.tool != nil {
                out.append(block)
                continue
            }
            if partial(block) { continue }
            guard let emoji = emoji(block.text) else {
                out.append(block)
                continue
            }
            if let target {
                // The reaction is the whole answer: the thinking and steps
                // behind it would only draw an empty reply. Errors still show.
                let after = out[(target + 1)...].filter { $0.role == "system" && $0.notice != nil }
                out.removeSubrange((target + 1)...)
                out.append(contentsOf: after)
                out[target].monoReaction = emoji
            } else {
                var shown = block
                shown.text = emoji
                out.append(shown)
            }
        }
        return out
    }
}
