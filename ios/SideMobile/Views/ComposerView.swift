import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// What the composer hands over: the text, its files, and whether to plan first.
struct Outgoing {
    let text: String
    let attachments: [Attachment]
    let plan: Bool
}

/// The IDE's composer: a box with the working copy above the text, and a bar
/// of chips (model, effort, permissions, account) beside the send button.
struct ComposerView<Context: View, Tools: View>: View {
    @Environment(AppModel.self) private var model
    var placeholder = "Ask, build, plan…"
    var running = false
    var disabled = false
    /// Offers the "Plan" toggle: the agent proposes a plan before building.
    var canPlan = false
    var allowsAttachments = true
    /// Replaces the draft when its nonce changes (editing the last message).
    var seed: (text: String, nonce: Int)?
    var banner: String?
    var onCancelBanner: (() -> Void)?
    var hint: String?
    var onStop: (() -> Void)?
    let onSend: (Outgoing) async throws -> Void
    @ViewBuilder var context: () -> Context
    @ViewBuilder var tools: () -> Tools

    @State private var text = ""
    @State private var attachments: [Attachment] = []
    @State private var uploading = 0
    @State private var sending = false
    @State private var plan = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var failure: String?
    @State private var sent = 0
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !disabled && !sending && uploading == 0 && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let banner {
                HStack {
                    Text(banner)
                    Spacer()
                    if let onCancelBanner { Button("Cancel", action: onCancelBanner).foregroundStyle(Theme.muted) }
                }
                .font(Theme.meta)
                .foregroundStyle(Theme.accent)
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
            HStack(spacing: 10) { context() }
                .font(Theme.meta)
                .foregroundStyle(Theme.muted)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.top, 8)
            if !attachments.isEmpty || uploading > 0 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(attachments, id: \.id) { attachment in
                            HStack(spacing: 6) {
                                Image(systemName: attachment.kind == "image" ? "photo" : "doc").foregroundStyle(Theme.muted)
                                Text(attachment.name).lineLimit(1)
                                Button {
                                    attachments.removeAll { $0.id == attachment.id }
                                } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(Theme.muted)
                            }
                            .font(Theme.meta)
                            .padding(.horizontal, 8)
                            .frame(height: 28)
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.strokeStrong))
                        }
                        if uploading > 0 { ProgressView().controlSize(.small) }
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 8)
                }
            }
            TextField(running ? "Queue a follow-up…" : placeholder, text: $text, axis: .vertical)
                .font(.system(size: 15))
                .lineLimit(1...10)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 4)
            if let failure {
                Text(failure).font(Theme.meta).foregroundStyle(Theme.delFg).padding(.horizontal, 12)
            }
            HStack(spacing: 4) {
                if allowsAttachments {
                    Menu {
                        PhotosPicker(selection: $photos, maxSelectionCount: 6, matching: .images) {
                            Label("Photos", systemImage: "photo")
                        }
                        Button { importing = true } label: { Label("Files", systemImage: "folder") }
                    } label: {
                        Image(systemName: "plus").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.muted).frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        if canPlan {
                            Button { plan.toggle() } label: { ChipLabel(text: "Plan", on: plan) }.buttonStyle(.plain)
                        }
                        tools()
                    }
                    .padding(.trailing, 12)
                }
                // The last chips fade out under the send button, so the row
                // reads as one that scrolls rather than one cut short.
                .mask(
                    HStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 16)
                    }
                )
                if let hint {
                    Text(hint).font(Theme.meta).foregroundStyle(Theme.faint).lineLimit(1)
                    Spacer(minLength: 0)
                }
                if running, let onStop, !canSend {
                    Button(action: onStop) {
                        Image(systemName: "stop.fill").font(.system(size: 11))
                            .frame(width: 28, height: 28)
                            .foregroundStyle(Theme.text)
                            .background(Theme.fill, in: .rect(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                } else {
                    Button {
                        Task { await send() }
                    } label: {
                        Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold))
                            .frame(width: 28, height: 28)
                            .foregroundStyle(canSend ? Theme.bg : Theme.faint)
                            .background(canSend ? Theme.text : Theme.fill, in: .rect(cornerRadius: 6))
                            .opacity(sending ? 0.5 : 1)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .padding(.bottom, 6)
        }
        .background(Theme.bg.opacity(0.9), in: .rect(cornerRadius: 10))
        .background(Theme.fillSubtle, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(focused ? Theme.text.opacity(0.2) : Theme.strokeStrong))
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .onChange(of: seed?.nonce) {
            if let seed {
                text = seed.text
                focused = !seed.text.isEmpty
            }
        }
        .onChange(of: photos) { _, items in
            photos = []
            for item in items { Task { await upload(photo: item) } }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls { Task { await upload(file: url) } }
        }
    }

    private func send() async {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        failure = nil
        defer { sending = false }
        do {
            try await onSend(Outgoing(text: message, attachments: attachments, plan: plan))
            text = ""
            attachments = []
            plan = false
            sent += 1
        } catch {
            // The draft stays for another try.
            failure = error.localizedDescription
        }
    }

    private func upload(photo item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        // HEIC photos go as JPEG: every harness reads that.
        let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) ?? data
        await upload(jpeg, name: "photo-\(attachments.count + 1).jpg", mimeType: "image/jpeg")
    }

    private func upload(file url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        await upload(data, name: url.lastPathComponent, mimeType: mimeType)
    }

    private func upload(_ data: Data, name: String, mimeType: String) async {
        guard let client = model.client else { return }
        uploading += 1
        defer { uploading -= 1 }
        do {
            attachments.append(try await client.upload(data: data, name: name, mimeType: mimeType))
        } catch {
            failure = error.localizedDescription
        }
    }
}

/// The look of a composer chip: a hairline box with a label and a caret.
struct ChipLabel: View {
    var icon: AnyView?
    let text: String
    var on = false
    var caret = false

    var body: some View {
        HStack(spacing: 5) {
            if let icon { icon }
            Text(text).lineLimit(1)
            if caret { Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.faint) }
        }
        .font(.system(size: 12.5))
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 7)
        .frame(height: 26)
        .frame(maxWidth: 200)
        .background(on ? Theme.accent.opacity(0.18) : .clear, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(on ? Theme.accent.opacity(0.45) : Theme.stroke))
    }
}

/// A chip that opens a menu of choices, as the desktop's composer selects.
struct Chip<Content: View>: View {
    var icon: AnyView?
    let label: String
    var disabled = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        Menu {
            content()
        } label: {
            ChipLabel(icon: icon, text: label, caret: true)
        }
        // iOS 26 wraps a bare menu in its own glass pill, around the chip's.
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }
}

/// A row of a chip's menu, ticked when chosen.
struct ChoiceButton: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if selected { Label(label, systemImage: "checkmark") } else { Text(label) }
        }
    }
}

/// How full the context window is, as the desktop's ring.
struct ContextMeter: View {
    let ratio: Double

    var body: some View {
        HStack(spacing: 4) {
            ZStack {
                Circle().stroke(Theme.muted.opacity(0.4), lineWidth: 2)
                Circle().trim(from: 0, to: ratio).stroke(ratio > 0.85 ? Theme.amber : Theme.muted, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
            }
            .frame(width: 11, height: 11)
            Text("\(Int((ratio * 100).rounded()))%").font(Theme.monoSmall)
        }
    }
}
