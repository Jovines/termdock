# Termdock shell integration for bash.
# Based on Ghostty's bash integration (GPL-3.0), adapted for termdock.
#
# Emits:
#   OSC 133;P — prompt start (in PS1)
#   OSC 133;B — input start (in PS1)
#   OSC 133;C — command start (preexec via PS0)
#   OSC 133;D;exitcode — command end (precmd)
#   OSC 2;title — window title (cwd when idle, command when running)
#   OSC 7;cwd — current working directory

if [[ "$-" != *i* ]]; then builtin return; fi

_termdock_executing=""
_termdock_last_reported_cwd=""

function __termdock_precmd() {
    local ret="$?"
    if test "$_termdock_executing" != "0"; then
        _TERMDOCK_SAVE_PS1="$PS1"
        _TERMDOCK_SAVE_PS2="$PS2"

        PS1='\[\e]133;P;k=i\a\]'$PS1'\[\e]133;B\a\]'
        PS2='\[\e]133;P;k=s\a\]'$PS2'\[\e]133;B\a\]'

        if [[ "$PS1" == *"\n"* ]]; then
            PS1="${PS1//\\n/\\n$'\\[\\e]133;P;k=s\\a\\]'}"
        fi

        # Title: cwd when idle
        PS1=$PS1'\[\e]2;\w\a\]'
    fi

    if test "$_termdock_executing" != ""; then
        builtin printf "\e]133;D;%s;aid=%s\a" "$ret" "$BASHPID"
    fi

    builtin printf "\e]133;A;redraw=last;cl=line;aid=%s\a" "$BASHPID"

    if [[ "$_termdock_last_reported_cwd" != "$PWD" ]]; then
        _termdock_last_reported_cwd="$PWD"
        builtin printf "\e]7;kitty-shell-cwd://%s%s\a" "$HOSTNAME" "$PWD"
    fi

    _termdock_executing=0
}

function __termdock_preexec() {
    builtin local cmd="$1"

    PS1="$_TERMDOCK_SAVE_PS1"
    PS2="$_TERMDOCK_SAVE_PS2"

    # Title: command name when running
    if [[ -n $cmd ]]; then
        builtin printf "\e]2;%s\a" "${cmd//[[:cntrl:]]/}"
    fi

    # End of input, start of output
    builtin printf "\e]133;C\a"
    _termdock_executing=1
}

if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
    __termdock_preexec_hook() {
        builtin local cmd
        cmd=$(LC_ALL=C HISTTIMEFORMAT='' builtin history 1)
        cmd="${cmd#*[[:digit:]][* ] }"
        [[ -n "$cmd" ]] && __termdock_preexec "$cmd"
    }

    __termdock_hook() {
        builtin local ret=$?
        __termdock_precmd "$ret"

        if [[ "$PS0" != *"__termdock_preexec_hook"* ]]; then
            if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3) )); then
                PS0+='${ __termdock_preexec_hook; }'
            else
                PS0+='$(__termdock_preexec_hook >/dev/tty)'
            fi
        fi
    }

    # shellcheck disable=SC2128,SC2178,SC2179
    if [[ ";${PROMPT_COMMAND[*]:-};" != *";__termdock_hook 2>/dev/null;"* ]]; then
        if [[ -z "${PROMPT_COMMAND[*]}" ]]; then
            if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
                PROMPT_COMMAND=("__termdock_hook 2>/dev/null")
            else
                PROMPT_COMMAND="__termdock_hook 2>/dev/null"
            fi
        elif [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a "* ]]; then
            PROMPT_COMMAND+=("__termdock_hook 2>/dev/null")
        else
            [[ "${PROMPT_COMMAND}" =~ (\;[[:space:]]*|$'\n')$ ]] || PROMPT_COMMAND+=";"
            PROMPT_COMMAND+="__termdock_hook 2>/dev/null"
        fi
    fi
else
    # Bash < 4.4: use bash-preexec.sh if available
    if [[ -f "$(dirname -- "${BASH_SOURCE[0]}")/bash-preexec.sh" ]]; then
        builtin source "$(dirname -- "${BASH_SOURCE[0]}")/bash-preexec.sh"
        preexec_functions+=(__termdock_preexec)
        precmd_functions+=(__termdock_precmd)
    fi
fi
