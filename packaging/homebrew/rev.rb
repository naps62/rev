# Canonical copy of the tap formula. scripts/release.sh and the release
# workflow rewrite url/sha256/version here and push it to naps62/homebrew-tap
# as Formula/rev.rb — edit this file, never the tap's copy.
class Rev < Formula
  desc "Always-on local code review server for every git repo on the machine"
  homepage "https://github.com/naps62/rev"
  url "https://github.com/naps62/rev/releases/download/v0.1.0/rev-0.1.0.tar.gz"
  sha256 "347c1b2aa9ec5ebf8fd25dde41c5581ee14844692129553520c709e5f7ef3e76"
  version "0.1.0"

  depends_on "git"
  depends_on "node"

  def install
    libexec.install Dir["*"]
    # The daemon must not inherit whatever node a user's toolchain fronts.
    (bin/"rev").write_env_script libexec/"bin/rev",
                                 PATH: "#{Formula["node"].opt_bin}:$PATH"
  end

  service do
    run [opt_bin/"rev", "serve"]
    keep_alive true
    log_path var/"log/rev.log"
    error_log_path var/"log/rev.log"
    environment_variables PATH:         std_service_path_env,
                          NODE_ENV:     "production",
                          REV_ROOTS:    Dir.home,
                          REV_DEPTH:    "3",
                          REV_SEM_BIN:  "#{Dir.home}/.local/bin/sem"
  end

  def caveats
    <<~EOS
      Start the server:
        brew services start rev
      Then open http://localhost:7373

      Claude Code hooks are not wired up by brew. To install them:
        rev install-hooks

      Per-machine config goes in ~/.config/rev/env (REV_PORT, REV_HOST,
      REV_ROOTS, ...); it survives upgrades. The server binds 127.0.0.1 and
      has no auth — see the README before setting REV_HOST=0.0.0.0.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/rev version").strip
    assert_match "always-on local code review", shell_output("#{bin}/rev help")
  end
end
