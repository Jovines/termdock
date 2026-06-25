# Termdock shell integration for fish.
# Based on Ghostty's fish integration (GPL-3.0), adapted for termdock.
#
# Emits:
#   OSC 133;A — prompt start
#   OSC 133;C — command start (preexec)
#   OSC 133;D;exitcode — command end (postexec)
#   OSC 2;title — window title (cwd when idle, command when running)
#   OSC 7;cwd — current working directory

function _termdock_exit -d "exit the shell integration setup"
    functions -e _termdock_exit
    exit 0
end

status --is-interactive || _termdock_exit

function __termdock_setup --on-event fish_prompt -d "Setup termdock integration"
    functions -e __termdock_setup

    set -g __termdock_prompt_start_mark "\e]133;A\a"

    # Prompt marks
    function __termdock_mark_prompt_start --on-event fish_prompt --on-event fish_posterror
        if test "$__termdock_prompt_state" != prompt-start
            echo -en "\e]133;D\a"
        end
        set --global __termdock_prompt_state prompt-start
        echo -en $__termdock_prompt_start_mark

        # Title: cwd when idle
        printf '\e]2;%s\a' (string replace -r "^$HOME" "~" -- "$PWD" 2>/dev/null; or echo "$PWD")
    end

    function __termdock_mark_output_start --on-event fish_preexec
        set --global __termdock_prompt_state pre-exec
        # Title: command name when running
        printf '\e]2;%s\a' (string replace -r '[[:cntrl:]]' '' -- "$argv" 2>/dev/null; or echo "$argv")
        echo -en "\e]133;C\a"
    end

    function __termdock_mark_output_end --on-event fish_postexec
        set --global __termdock_prompt_state post-exec
        echo -en "\e]133;D;$status\a"
    end

    # Report cwd
    function __update_cwd_osc --on-variable PWD -d 'Notify terminal when PWD changes'
        if status --is-command-substitution || set -q INSIDE_EMACS
            return
        end
        printf \e\]7\;kitty-shell-cwd://%s%s\a $hostname (string escape --style=url $PWD)
    end

    # Initial calls for first prompt
    __termdock_mark_prompt_start
    __update_cwd_osc
end

_termdock_exit
